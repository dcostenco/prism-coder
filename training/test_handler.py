#!/usr/bin/env python3
"""
BFCL Handler Test Suite — prism-coder

Validates the PrismCoderHandler against all BFCL scoring categories:
1. Non-Live (10%): Single-turn function calling with type coercion
2. Live (10%): Real-world API calls  
3. Irrelevance (10%): Correctly abstains when no tool matches
4. Multi-Turn (30%): Multi-turn conversation with tool calling
5. Agentic (40%): Memory + WebSearch via multi-turn FC loop

Run: python test_handler.py
Run verbose: python test_handler.py -v

Requires: Ollama running with a Qwen2.5-Coder model pulled.
"""

import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add BFCL repo to PATH
BFCL_DIR = Path.home() / "gorilla-bfcl" / "berkeley-function-call-leaderboard"
sys.path.insert(0, str(BFCL_DIR))

from bfcl_eval.model_handler.local_inference.prism_coder import PrismCoderHandler


class TestExtractToolCalls(unittest.TestCase):
    """Test _extract_tool_calls — the core parsing logic."""

    def test_standard_tool_call_tag(self):
        """Standard <|tool_call|> tag extraction."""
        text = '<|tool_call|>\n{"name": "get_weather", "arguments": {"city": "London"}}\n</|tool_call|>'
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "get_weather")
        self.assertEqual(result[0]["arguments"]["city"], "London")

    def test_tool_call_no_newlines(self):
        """<|tool_call|> without newlines around JSON (whitespace-tolerant)."""
        text = '<|tool_call|>{"name": "ls", "arguments": {}}</|tool_call|>'
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "ls")

    def test_parallel_tool_calls(self):
        """Multiple parallel tool calls."""
        text = (
            '<|tool_call|>\n{"name": "get_weather", "arguments": {"city": "London"}}\n</|tool_call|>\n'
            '<|tool_call|>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</|tool_call|>'
        )
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["arguments"]["city"], "London")
        self.assertEqual(result[1]["arguments"]["city"], "Paris")

    def test_bare_json_object(self):
        """Bare JSON object without tags."""
        text = '{"name": "mkdir", "arguments": {"dir_name": "test"}}'
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "mkdir")

    def test_abstention_plain_text(self):
        """Plain text response = abstention (no tool call)."""
        text = "I don't have the right tools for that request."
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(result, [])

    def test_abstention_empty(self):
        """Empty string = abstention."""
        result = PrismCoderHandler._extract_tool_calls("")
        self.assertEqual(result, [])

    def test_think_tags_stripped(self):
        """<|synalux_think|> tags should be stripped before extraction."""
        text = '<|synalux_think|>\nLet me analyze this...\n</|synalux_think|>\n\n<|tool_call|>\n{"name": "ls", "arguments": {}}\n</|tool_call|>'
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "ls")

    def test_irrelevant_braces_ignored(self):
        """Text containing { but no valid tool call should return empty."""
        text = "The formula is {x + y = z} where x and y are integers."
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(result, [])

    def test_nested_json_arguments(self):
        """Tool call with nested JSON arguments."""
        text = '<|tool_call|>\n{"name": "create_event", "arguments": {"title": "Meeting", "attendees": [{"name": "Alice"}, {"name": "Bob"}]}}\n</|tool_call|>'
        result = PrismCoderHandler._extract_tool_calls(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "create_event")
        self.assertEqual(len(result[0]["arguments"]["attendees"]), 2)


class TestTypeCercion(unittest.TestCase):
    """Test language-aware type coercion — critical for Java/JS compat."""

    def test_python_bool_coercion(self):
        """Python: 'true'/'false' strings → True/False."""
        args = {"enabled": "true", "verbose": "false"}
        fixed = PrismCoderHandler._fix_argument_types(args, language="Python")
        self.assertIs(fixed["enabled"], True)
        self.assertIs(fixed["verbose"], False)

    def test_python_null_coercion(self):
        """Python: 'null'/'none' → None."""
        args = {"value": "null", "other": "none"}
        fixed = PrismCoderHandler._fix_argument_types(args, language="Python")
        self.assertIsNone(fixed["value"])
        self.assertIsNone(fixed["other"])

    def test_java_no_bool_coercion(self):
        """Java: 'true'/'false' should STAY as strings."""
        args = {"enabled": "true", "name": "test"}
        fixed = PrismCoderHandler._fix_argument_types(args, language="Java")
        self.assertEqual(fixed["enabled"], "true")  # NOT True
        self.assertEqual(fixed["name"], "test")

    def test_javascript_no_bool_coercion(self):
        """JavaScript: 'true'/'false' should STAY as strings."""
        args = {"flag": "false"}
        fixed = PrismCoderHandler._fix_argument_types(args, language="JavaScript")
        self.assertEqual(fixed["flag"], "false")  # NOT False

    def test_stringified_json_object(self):
        """Stringified JSON '{"key": "val"}' → {"key": "val"} (all languages)."""
        args = {"config": '{"host": "localhost", "port": 5432}'}
        fixed = PrismCoderHandler._fix_argument_types(args, language="Python")
        self.assertIsInstance(fixed["config"], dict)
        self.assertEqual(fixed["config"]["host"], "localhost")

    def test_extra_quoted_string(self):
        """Extra-quoted: \"'USERSPACE1'\" → \"USERSPACE1\" (all languages)."""
        args = {"namespace": "'USERSPACE1'"}
        fixed = PrismCoderHandler._fix_argument_types(args, language="Java")
        self.assertEqual(fixed["namespace"], "USERSPACE1")

    def test_nested_dict(self):
        """Nested dicts should be recursively fixed."""
        args = {"outer": {"inner_bool": "true"}}
        fixed = PrismCoderHandler._fix_argument_types(args, language="Python")
        self.assertIs(fixed["outer"]["inner_bool"], True)

    def test_list_values(self):
        """Lists should be recursively fixed."""
        args = {"items": ["true", "false", "hello"]}
        fixed = PrismCoderHandler._fix_argument_types(args, language="Python")
        self.assertEqual(fixed["items"], [True, False, "hello"])


class TestDecodeAst(unittest.TestCase):
    """Test decode_ast — called by the BFCL evaluator for scoring."""

    def setUp(self):
        """Create handler with mocked Ollama connection."""
        with patch.object(PrismCoderHandler, '__init__', lambda self, *a, **k: None):
            self.handler = PrismCoderHandler.__new__(PrismCoderHandler)

    def test_single_call(self):
        """Single function call → [{name: args}] format."""
        result = '<|tool_call|>\n{"name": "get_weather", "arguments": {"city": "NY"}}\n</|tool_call|>'
        decoded = self.handler.decode_ast(result, "Python", False)
        self.assertEqual(len(decoded), 1)
        self.assertIn("get_weather", decoded[0])
        self.assertEqual(decoded[0]["get_weather"]["city"], "NY")

    def test_abstention_returns_empty(self):
        """Abstention (no tool call) → [] for irrelevance checker."""
        result = "I can't help with that."
        decoded = self.handler.decode_ast(result, "Python", False)
        self.assertEqual(decoded, [])

    def test_multiple_calls(self):
        """Parallel function calls → list of {name: args}."""
        result = (
            '<|tool_call|>\n{"name": "func_a", "arguments": {"x": 1}}\n</|tool_call|>\n'
            '<|tool_call|>\n{"name": "func_b", "arguments": {"y": 2}}\n</|tool_call|>'
        )
        decoded = self.handler.decode_ast(result, "Python", False)
        self.assertEqual(len(decoded), 2)
        self.assertIn("func_a", decoded[0])
        self.assertIn("func_b", decoded[1])

    def test_java_bool_stays_string(self):
        """Java decode: 'true' arg stays as string."""
        result = '<|tool_call|>\n{"name": "setFlag", "arguments": {"enabled": "true"}}\n</|tool_call|>'
        decoded = self.handler.decode_ast(result, "Java", False)
        self.assertEqual(decoded[0]["setFlag"]["enabled"], "true")

    def test_python_bool_converted(self):
        """Python decode: 'true' arg → True."""
        result = '<|tool_call|>\n{"name": "setFlag", "arguments": {"enabled": "true"}}\n</|tool_call|>'
        decoded = self.handler.decode_ast(result, "Python", False)
        self.assertIs(decoded[0]["setFlag"]["enabled"], True)


class TestFormatPrompt(unittest.TestCase):
    """Test _format_prompt — the prompt assembly logic."""

    def setUp(self):
        with patch.object(PrismCoderHandler, '__init__', lambda self, *a, **k: None):
            self.handler = PrismCoderHandler.__new__(PrismCoderHandler)

    def test_basic_single_turn(self):
        """Basic single-turn: system + user + tools."""
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "What's the weather?"},
        ]
        tools = [{"name": "get_weather", "description": "Get weather", "parameters": {}}]
        
        prompt = self.handler._format_prompt(messages, tools)
        
        self.assertIn("<|im_start|>system", prompt)
        self.assertIn("You are helpful.", prompt)
        self.assertIn("<tools>", prompt)
        self.assertIn("get_weather", prompt)
        self.assertIn("IMPORTANT RULES:", prompt)
        self.assertIn("If NONE of the provided functions are relevant", prompt)
        self.assertTrue(prompt.endswith("<|im_start|>assistant\n"))

    def test_no_think_tags_by_default(self):
        """Default: no <|synalux_think|> tags injected (Qwen2.5-Coder doesn't support them)."""
        messages = [{"role": "user", "content": "Hello"}]
        prompt = self.handler._format_prompt(messages, [])
        self.assertNotIn("<|synalux_think|>", prompt)
        self.assertTrue(prompt.endswith("<|im_start|>assistant\n"))

    def test_think_tags_with_env(self):
        """With PRISM_ENABLE_THINKING=1, <|synalux_think|> tags ARE injected."""
        messages = [{"role": "user", "content": "Hello"}]
        with patch.dict(os.environ, {"PRISM_ENABLE_THINKING": "1"}):
            prompt = self.handler._format_prompt(messages, [])
        self.assertIn("<|synalux_think|>", prompt)
        self.assertIn("</|synalux_think|>", prompt)

    def test_tool_response_native_role(self):
        """CRITICAL: Tool responses must use native <|im_start|>tool role."""
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "List files"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "ls", "arguments": {}}}
            ]},
            {"role": "tool", "content": '["file1.txt", "file2.py"]'},
            {"role": "user", "content": "Now delete file1.txt"},
        ]
        tools = [{"name": "ls"}, {"name": "rm"}]
        
        prompt = self.handler._format_prompt(messages, tools)
        
        # Tool response MUST use native <|im_start|>tool role
        self.assertIn("<|im_start|>tool\n", prompt)
        self.assertIn('["file1.txt", "file2.py"]', prompt)
        self.assertIn("<|im_end|>", prompt)

    def test_consecutive_tool_responses_separate(self):
        """Multiple tool responses should each use native <|im_start|>tool role."""
        messages = [
            {"role": "user", "content": "Get weather for London and Paris"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "get_weather", "arguments": {"city": "London"}}},
                {"function": {"name": "get_weather", "arguments": {"city": "Paris"}}},
            ]},
            {"role": "tool", "content": '{"temp": 15}'},
            {"role": "tool", "content": '{"temp": 20}'},
        ]
        tools = [{"name": "get_weather"}]
        
        prompt = self.handler._format_prompt(messages, tools)
        
        # Each tool response should have its own <|im_start|>tool block
        tool_count = prompt.count("<|im_start|>tool\n")
        self.assertEqual(tool_count, 2, "Each tool response should have separate <|im_start|>tool block")

    def test_abstention_instruction_present(self):
        """System prompt MUST contain abstention instruction when tools present."""
        messages = [{"role": "user", "content": "Hello"}]
        tools = [{"name": "func1"}]
        prompt = self.handler._format_prompt(messages, tools)
        self.assertIn("If NONE of the provided functions are relevant", prompt)

    def test_no_tools_no_abstention(self):
        """Without tools, no abstention instruction needed."""
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
        ]
        prompt = self.handler._format_prompt(messages, [])
        self.assertNotIn("If NONE of the provided functions", prompt)


class TestDecodeExecute(unittest.TestCase):
    """Test decode_execute — used in multi-turn to execute tool calls."""

    def setUp(self):
        with patch.object(PrismCoderHandler, '__init__', lambda self, *a, **k: None):
            self.handler = PrismCoderHandler.__new__(PrismCoderHandler)

    def test_single_call_execute(self):
        """decode_execute returns executable function call format."""
        result = '<|tool_call|>\n{"name": "ls", "arguments": {}}\n</|tool_call|>'
        decoded = self.handler.decode_execute(result, False)
        self.assertIsInstance(decoded, list)
        self.assertTrue(len(decoded) > 0)

    def test_abstention_execute(self):
        """decode_execute returns [] for abstention."""
        result = "I can't help with that."
        decoded = self.handler.decode_execute(result, False)
        self.assertEqual(decoded, [])


class TestParseQueryResponse(unittest.TestCase):
    """Test _parse_query_response_FC — the multi-turn response parser."""

    def setUp(self):
        with patch.object(PrismCoderHandler, '__init__', lambda self, *a, **k: None):
            self.handler = PrismCoderHandler.__new__(PrismCoderHandler)

    def _make_response(self, text):
        """Create a mock API response."""
        resp = MagicMock()
        resp.choices = [MagicMock()]
        resp.choices[0].text = text
        resp.usage = MagicMock()
        resp.usage.prompt_tokens = 100
        resp.usage.completion_tokens = 50
        return resp

    def test_tool_call_response(self):
        """Tool call → message with tool_calls for chat history."""
        resp = self._make_response(
            '<|tool_call|>\n{"name": "ls", "arguments": {}}\n</|tool_call|>'
        )
        parsed = self.handler._parse_query_response_FC(resp)
        msg = parsed["model_responses_message_for_chat_history"]
        self.assertEqual(msg["role"], "assistant")
        self.assertIn("tool_calls", msg)
        self.assertEqual(msg["tool_calls"][0]["function"]["name"], "ls")

    def test_abstention_response(self):
        """Abstention → message with content, no tool_calls."""
        resp = self._make_response("I don't have the right tools.")
        parsed = self.handler._parse_query_response_FC(resp)
        msg = parsed["model_responses_message_for_chat_history"]
        self.assertEqual(msg["role"], "assistant")
        self.assertNotIn("tool_calls", msg)
        self.assertIn("don't have", msg["content"])

    def test_reasoning_extraction(self):
        """<|synalux_think|> content should be extracted into reasoning_content."""
        resp = self._make_response(
            '<|synalux_think|>\nAnalyzing the request...\n</|synalux_think|>\n\n<|tool_call|>\n{"name": "ls", "arguments": {}}\n</|tool_call|>'
        )
        parsed = self.handler._parse_query_response_FC(resp)
        self.assertIn("Analyzing the request", parsed["reasoning_content"])
        msg = parsed["model_responses_message_for_chat_history"]
        self.assertEqual(msg["reasoning_content"], parsed["reasoning_content"])


class TestTrainingDataFormat(unittest.TestCase):
    """Validate that training data format matches what the handler expects."""

    def test_training_data_messages_format(self):
        """Training data MUST use the same role format as the handler."""
        # Simulate a multi-turn training example
        messages = [
            {"role": "system", "content": "# Tools\n..."},
            {"role": "user", "content": "List files"},
            {"role": "assistant", "content": '<|tool_call|>\n{"name": "ls", "arguments": {}}\n</|tool_call|>',
             "tool_calls": [{"function": {"name": "ls", "arguments": {}}}]},
            {"role": "tool", "content": '["file1.txt"]'},
            {"role": "user", "content": "Delete file1.txt"},
        ]
        
        # The handler's _format_prompt should handle this correctly
        with patch.object(PrismCoderHandler, '__init__', lambda self, *a, **k: None):
            handler = PrismCoderHandler.__new__(PrismCoderHandler)
        
        tools = [{"name": "ls"}, {"name": "rm"}]
        prompt = handler._format_prompt(messages, tools)
        
        # Verify tool response uses native <|im_start|>tool role
        self.assertIn("<|im_start|>tool\n", prompt)
        # Verify the conversation maintains proper structure
        self.assertIn("<|im_start|>assistant", prompt)


class TestMultiTurnChain(unittest.TestCase):
    """Test multi-turn tool call chains (40% BFCL agentic weight).
    
    These tests validate that the handler correctly formats multi-turn
    conversations where tool responses are injected between user turns.
    """

    def setUp(self):
        with patch.object(PrismCoderHandler, '__init__', lambda self, *a, **k: None):
            self.handler = PrismCoderHandler.__new__(PrismCoderHandler)

    def test_sequential_tool_chain_format(self):
        """Turn1: user→tool_call, Turn2: tool_response→user→tool_call.
        
        Validates that the prompt includes the tool response in the conversation
        history using <|im_start|>tool role format.
        """
        messages = [
            {"role": "system", "content": "# Tools\nAvailable: session_load_context, session_search_memory"},
            {"role": "user", "content": "Load context for analytics, then search for deploy issues."},
            {"role": "assistant", "content": '<|tool_call|>\n{"name": "session_load_context", "arguments": {"project": "analytics"}}\n</|tool_call|>',
             "tool_calls": [{"function": {"name": "session_load_context", "arguments": {"project": "analytics"}}}]},
            {"role": "tool", "content": '{"project": "analytics", "open_todos": ["fix deploy"]}'},
            {"role": "user", "content": "Now search for deployment issues."},
        ]
        
        tools = [{"name": "session_load_context"}, {"name": "session_search_memory"}]
        prompt = self.handler._format_prompt(messages, tools)
        
        # Verify tool response is in the conversation history
        self.assertIn("<|im_start|>tool\n", prompt)
        self.assertIn("analytics", prompt)
        # Verify conversation has proper multi-turn structure
        user_count = prompt.count("<|im_start|>user")
        self.assertGreaterEqual(user_count, 2, "Multi-turn should have ≥2 user messages")

    def test_conditional_branching_after_tool_response(self):
        """Model should choose next tool based on tool response content.
        
        After health_check returns issues, the model should call compact_ledger.
        """
        messages = [
            {"role": "system", "content": "# Tools\nAvailable: session_health_check, session_compact_ledger"},
            {"role": "user", "content": "Run health check, then compact if issues found."},
            {"role": "assistant", "content": '<|tool_call|>\n{"name": "session_health_check", "arguments": {}}\n</|tool_call|>',
             "tool_calls": [{"function": {"name": "session_health_check", "arguments": {}}}]},
            {"role": "tool", "content": '{"status": "issues_found", "missing_embeddings": 12}'},
        ]
        
        tools = [{"name": "session_health_check"}, {"name": "session_compact_ledger"}]
        prompt = self.handler._format_prompt(messages, tools)
        
        # Verify the tool response with issues is visible
        self.assertIn("issues_found", prompt)
        self.assertIn("missing_embeddings", prompt)
        # Verify the prompt ends with assistant prefix (ready for next generation)
        self.assertTrue(prompt.rstrip().endswith("<|im_start|>assistant") or
                       prompt.rstrip().endswith("<|im_end|>"),
                       "Prompt should end ready for model generation")

    def test_abstention_after_tool_response(self):
        """Model should NOT call a tool when the tool response resolves the query.
        
        After task_route returns 'host', the model should just respond in text.
        """
        messages = [
            {"role": "system", "content": "# Tools\nAvailable: session_task_route"},
            {"role": "user", "content": "Should local agent handle this CSS fix?"},
            {"role": "assistant", "content": '<|tool_call|>\n{"name": "session_task_route", "arguments": {"task_description": "CSS fix"}}\n</|tool_call|>',
             "tool_calls": [{"function": {"name": "session_task_route", "arguments": {"task_description": "CSS fix"}}}]},
            {"role": "tool", "content": '{"target": "host", "confidence": 0.92}'},
        ]
        
        tools = [{"name": "session_task_route"}]
        prompt = self.handler._format_prompt(messages, tools)
        
        # Verify the routing result is visible to the model
        self.assertIn("host", prompt)
        self.assertIn("0.92", prompt)


if __name__ == "__main__":
    print("=" * 60)
    print("BFCL Handler Test Suite — prism-coder")
    print("=" * 60)
    print(f"Handler: {BFCL_DIR / 'bfcl_eval/model_handler/local_inference/prism_coder.py'}")
    print()
    
    # Run tests
    unittest.main(verbosity=2)
