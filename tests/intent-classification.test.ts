/**
 * Intent Classification Test Suite
 * 
 * Comprehensive tests for prompt intent detection and response validation.
 * Covers all 7 ABA rules + behavioral anti-patterns.
 * 
 * Categories:
 *   1. Tool requests (browser, terminal, git)
 *   2. Action requests (fix, deploy, run)
 *   3. Clinical queries (patients, notes, appointments)
 *   4. Capability questions (what can you do, do you have X)
 *   5. Developer questions (vercel, CI, debugging)
 *   6. Ambiguous prompts (could be clinical or dev)
 *   7. Response validation (no negation, no hedging, proportional)
 */

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════
// INTENT CLASSIFIER
// ═══════════════════════════════════════════════════════

type Intent =
  | "tool_redirect"     // needs browser/terminal/git → LOCAL mode
  | "action_request"    // fix/deploy/run → ask for specifics or act
  | "clinical_query"    // patients/notes/appointments → use tools
  | "capability_query"  // what can you do → brief positive answer
  | "dev_question"      // vercel/CI/debugging → short actionable answer
  | "general_question"  // how/what/why → informative answer
  | "greeting"          // hi/hello → brief greeting
  | "unknown";

function classifyIntent(prompt: string): Intent {
  const p = prompt.trim().toLowerCase();

  // Tool redirect — mentions specific tools (highest priority)
  const toolPatterns = [
    /\b(open|launch|use|start)\s+(browser|terminal|shell|console)\b/,
    /\bgit\s+(push|pull|clone|commit|log|status|diff)\b/,
    /\b(run|execute)\s+(command|script|terminal|shell)\b/,
    /\blogin\s+(to\s+)?(vercel|github|supabase|dashboard)\b/,
    /\bcheck\s+(vercel\s+)?(deploy\s+)?(logs?|dashboard)\b/,
    /^open\s+browser/,
    /^run\s+terminal/,
    /^git\s+/,
  ];
  if (toolPatterns.some(p2 => p2.test(p))) return "tool_redirect";

  // Clinical queries — domain keywords override question structure
  const clinicalPatterns = [
    /\b(patient|patients|client|clients)\b/,
    /\b(soap|session\s+note|clinical\s+note|progress\s+note)\b/,
    /\b(appointment|appointments|schedule|scheduling)\b/,
    /\b(authorization|auth\s+hours|insurance)\b/,
    /\b(fba|bip|abc\s+data|behavior\s+plan)\b/,
    /\b(treatment\s+program|treatment\s+plan)\b/,
    /\b(caseload|billing|compliance)\b/,
    /\b(session\s+notes?)\b/,
  ];
  if (clinicalPatterns.some(p2 => p2.test(p))) return "clinical_query";

  // Capability queries
  const capabilityPatterns = [
    /\bwhat\s+(can|do)\s+you\s+(do|have|offer|provide)\b/,
    /\bdo\s+you\s+have\b/,
    /\bcan\s+you\b.*\?$/,
    /\bwhat\s+(tools|features|capabilities)\b/,
    /\bwhat\s+are\s+you(r)?\s+(capable|able)\b/,
    /\blist\s+(your\s+)?(tools|features|capabilities)\b/,
  ];
  if (capabilityPatterns.some(p2 => p2.test(p))) return "capability_query";

  // Dev questions — domain keywords (vercel, CI, npm) before action check
  const devPatterns = [
    /\bvercel\b/,
    /\b(ci|cd|ci\/cd|github\s+actions?)\b/,
    /\b(deploy|deployment)\s*(error|fail|issue|problem)?/,
    /\b(npm|node|typescript|webpack|vite|next\.?js)\b/,
    /\b(env\s+var|environment\s+variable)\b/,
  ];
  if (devPatterns.some(p2 => p2.test(p))) return "dev_question";

  // Action requests — imperative verbs (no question prefix)
  const actionPatterns = [
    /^(fix|deploy|update|create|delete|remove|build|install|start|stop)\b/,
    /,\s*(fix|deploy|update|create|delete|remove)\b/,
    /\b(fix|deploy|update)\s+(my|the|this|that|it|a)\b/,
  ];
  const questionExclude = /^(what|how|why|when|where|who|which|explain|describe)\b/;
  if (!questionExclude.test(p) && actionPatterns.some(p2 => p2.test(p))) return "action_request";

  // Greeting
  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|what'?s\s+up)\b/.test(p)) return "greeting";

  // General questions
  if (questionExclude.test(p)) return "general_question";

  return "unknown";
}

// ═══════════════════════════════════════════════════════
// RESPONSE VALIDATORS
// ═══════════════════════════════════════════════════════

function hasNegationLead(response: string): boolean {
  const forbidden = [
    /^I can'?t /i, /^I'?m unable to /i, /^I don'?t have /i,
    /^I don'?t currently /i, /^Unfortunately/i, /^I cannot /i,
    /^I'?m not able to /i, /^I do not have /i,
    /^Sorry,? (but )?I (can'?t|cannot|don'?t|am unable)/i,
    /^As a [\w-]+ (AI|assistant|model)/i,
    /^While I (can'?t|cannot|don'?t|am unable)/i,
    /^In (cloud|this) mode,? I (don'?t|cannot|can'?t)/i,
    /^At this time,? I (don'?t|cannot|can'?t)/i,
    /^Since I'?m /i,
    /^I apologize/i,
    /^Regrettably/i,
    /^I'?m afraid/i,
    /^As an AI/i,
    /^I am prohibited/i,
    /^While I'?d love to/i,
    /^To be honest/i,
    /^Sure[.,! \n]/i,
    /^Certainly[.,! \n]/i,
    /^I can certainly/i,
    /^(Yes|Sure|Certainly|Absolutely|Of course),? (let me|I('ll| will)|here)/i,
  ];
  return forbidden.some(p => p.test(response.trim()));
}

function mentionsLocalMode(response: string): boolean {
  return /\bLOCAL\s+mode\b/i.test(response);
}

function isActionable(response: string): boolean {
  // Tool redirect responses must contain actionable detail, not just "switch to LOCAL mode"
  const hasHow = /Cmd\+Shift\+P|command palette|settings|preferences/i.test(response);
  const hasUrl = /https?:\/\//i.test(response);
  const hasCommand = /`[^`]+`/i.test(response); // backtick-wrapped command
  const hasDescription = /will (launch|execute|run|open|do)|launches|executes/i.test(response);
  return hasHow || hasUrl || hasCommand || hasDescription;
}

function isExcessivelyVerbose(response: string, promptWords: number): boolean {
  const words = response.split(/\s+/).length;
  if (promptWords <= 3) return words > 30;
  if (promptWords <= 10) return words > 40;
  return words > 100;
}

function hasExcessiveApology(response: string): boolean {
  return /I apologize|I'm sorry for (the|any)|my apologies|sorry about that/i.test(response);
}

function hasHedging(response: string): boolean {
  return /^(I think|It seems|It appears|It looks like|It might|Perhaps|Maybe|It could)\b/i.test(response.trim());
}

function hasQuestionEcho(response: string): boolean {
  return /you('re| are) asking|you('d| would) like|I understand you want|let me understand/i.test(response);
}

function isPermissionSeeking(response: string): boolean {
  return /would you like me to|shall I (fix|update|change)|do you want me to|should I go ahead/i.test(response);
}

// ═══════════════════════════════════════════════════════
// 1. TOOL REDIRECT INTENT
// ═══════════════════════════════════════════════════════

describe("Intent: Tool Redirect", () => {
  const toolPrompts = [
    "open browser",
    "open browser fix vercel error",
    "open browser check logs and fix, prompt for login if needed",
    "run terminal",
    "run terminal command to check deploy status",
    "git push my code",
    "git pull origin main",
    "git commit -m 'fix'",
    "use terminal to run npm build",
    "launch browser to check vercel dashboard",
    "login to vercel and check deploy logs",
    "check deploy logs",
    "check vercel logs",
    "open browser, login to vercel",
  ];

  toolPrompts.forEach(prompt => {
    it(`classifies "${prompt}" as tool_redirect`, () => {
      expect(classifyIntent(prompt)).toBe("tool_redirect");
    });
  });

  describe("correct response for tool requests", () => {
    const goodResponse = "Switch to LOCAL mode in VS Code (Cmd+Shift+P → Synalux: Switch to Local). LOCAL mode launches a Chromium browser with full automation. What site do you need to open?";
    const lazyResponse = "Switch to LOCAL mode in the VS Code extension — it has browser tools that can do this.";
    const badResponse = "What were you hoping to do in the browser? I can help with tasks like managing patients.";
    const negationResponse = "I cannot directly open a browser. Please try LOCAL mode.";

    it("good response mentions LOCAL mode", () => {
      expect(mentionsLocalMode(goodResponse)).toBe(true);
    });

    it("good response is actionable (has HOW)", () => {
      expect(isActionable(goodResponse)).toBe(true);
    });

    it("lazy response mentions LOCAL but is NOT actionable", () => {
      expect(mentionsLocalMode(lazyResponse)).toBe(true);
      expect(isActionable(lazyResponse)).toBe(false);
    });

    it("bad response does NOT mention LOCAL mode", () => {
      expect(mentionsLocalMode(badResponse)).toBe(false);
    });

    it("negation response fails Rule 4", () => {
      expect(hasNegationLead(negationResponse)).toBe(true);
    });

    it("good response is concise (≤30 words for short prompt)", () => {
      expect(isExcessivelyVerbose(goodResponse, 2)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════
// 2. ACTION REQUEST INTENT
// ═══════════════════════════════════════════════════════

describe("Intent: Action Request", () => {
  const actionPrompts = [
    "fix the broken import",
    "delete the old file",
    "build the project",
    "start the dev server",
    "fix it",
    "stop the process",
  ];

  actionPrompts.forEach(prompt => {
    it(`classifies "${prompt}" as action_request`, () => {
      expect(classifyIntent(prompt)).toBe("action_request");
    });
  });

  describe("response validation for action requests", () => {
    it("verbose tutorial fails", () => {
      const response = "I can help you diagnose that Vercel deploy error. To start, please check the deploy logs directly on your Vercel dashboard. Look for specific error messages there. Common issues include missing environment variables, incorrect build commands, or dependency problems. For hands-on debugging, if you're using the Synalux VS Code extension, you can access terminal and browser tools directly within its local mode for full automation capabilities.";
      expect(isExcessivelyVerbose(response, 4)).toBe(true);
    });

    it("short question passes", () => {
      expect(isExcessivelyVerbose("What error do you see in the build log?", 4)).toBe(false);
    });

    it("permission-seeking fails Rule 5", () => {
      expect(isPermissionSeeking("Would you like me to fix this error?")).toBe(true);
    });

    it("direct action passes Rule 5", () => {
      expect(isPermissionSeeking("Fixed the import error. Rebuilt and deployed.")).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════
// 3. CLINICAL QUERY INTENT
// ═══════════════════════════════════════════════════════

describe("Intent: Clinical Query", () => {
  const clinicalPrompts = [
    "list my patients",
    "show patient John Doe",
    "create a SOAP note for today's session",
    "what appointments do I have today?",
    "check authorization hours for client Smith",
    "generate an FBA report",
    "list session notes from this week",
    "how many patients do I have?",
    "create a behavior plan for this client",
    "what's my caseload utilization?",
  ];

  clinicalPrompts.forEach(prompt => {
    it(`classifies "${prompt}" as clinical_query`, () => {
      expect(classifyIntent(prompt)).toBe("clinical_query");
    });
  });
});

// ═══════════════════════════════════════════════════════
// 4. CAPABILITY QUERY INTENT
// ═══════════════════════════════════════════════════════

describe("Intent: Capability Query", () => {
  const capabilityPrompts = [
    "what can you do?",
    "what tools do you have?",
    "do you have git access?",
    "can you generate reports?",
    "what features are available?",
    "list your capabilities",
    "what are you capable of?",
  ];

  capabilityPrompts.forEach(prompt => {
    it(`classifies "${prompt}" as capability_query`, () => {
      expect(classifyIntent(prompt)).toBe("capability_query");
    });
  });

  describe("response validation for capability queries", () => {
    it("brief positive answer passes", () => {
      const response = "Yes! I have tools for patient management, scheduling, clinical notes, communications, billing, reports, and more.";
      expect(isExcessivelyVerbose(response, 4)).toBe(false);
      expect(hasNegationLead(response)).toBe(false);
    });

    it("long tool dump fails brevity", () => {
      const response = "I have many tools. Here is a complete list: 1. list_patients for listing patients. 2. manage_patient for managing patients. 3. list_appointments for listing appointments. 4. manage_appointment for managing appointments. 5. get_today_schedule for getting schedule. 6. list_session_notes for listing notes. 7. manage_session_note for managing notes. 8. call_patient for calling. 9. send_sms for texting. 10. send_email for emails. 11. generate_report for reports. 12. export_data for data.";
      expect(isExcessivelyVerbose(response, 4)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════
// 5. DEV QUESTION INTENT
// ═══════════════════════════════════════════════════════

describe("Intent: Dev Question", () => {
  const devPrompts = [
    "why did my vercel deploy fail?",
    "what causes a next.js build error?",
    "how do I fix a CI failure?",
    "what's wrong with my deployment?",
    "how do I set environment variables in vercel?",
    "explain the npm build process",
    "fix my vercel error",
    "deploy the latest version",
  ];

  devPrompts.forEach(prompt => {
    it(`classifies "${prompt}" as dev_question`, () => {
      expect(classifyIntent(prompt)).toBe("dev_question");
    });
  });
});

// ═══════════════════════════════════════════════════════
// 6. AMBIGUOUS PROMPTS
// ═══════════════════════════════════════════════════════

describe("Intent: Ambiguous / Edge Cases", () => {
  it("'fix it' → action_request", () => {
    expect(classifyIntent("fix it")).toBe("action_request");
  });

  it("'hello' → greeting", () => {
    expect(classifyIntent("hello")).toBe("greeting");
  });

  it("'how does scheduling work?' → clinical_query (scheduling keyword)", () => {
    expect(classifyIntent("how does scheduling work?")).toBe("clinical_query");
  });

  it("'show my appointments' → clinical_query", () => {
    expect(classifyIntent("show my appointments")).toBe("clinical_query");
  });

  it("empty prompt → unknown", () => {
    expect(classifyIntent("")).toBe("unknown");
  });

  it("single character → unknown", () => {
    expect(classifyIntent("x")).toBe("unknown");
  });

  it("'open' alone → unknown (no tool specified)", () => {
    expect(classifyIntent("open")).toBe("unknown");
  });

  it("'git' alone → unknown (no action specified)", () => {
    expect(classifyIntent("git")).toBe("unknown");
  });
});

// ═══════════════════════════════════════════════════════
// 7. CROSS-RULE RESPONSE VALIDATION
// ═══════════════════════════════════════════════════════

describe("Cross-Rule Response Validation", () => {
  // Each test validates a response against ALL applicable rules

  describe("tool_redirect responses", () => {
    const prompt = "open browser";
    const intent = classifyIntent(prompt);

    it("intent is tool_redirect", () => {
      expect(intent).toBe("tool_redirect");
    });

    const responses = [
      {
        text: "Switch to LOCAL mode in VS Code (Cmd+Shift+P). LOCAL mode launches a Chromium browser with full automation. What site do you need?",
        passes: { negation: true, localMode: true, actionable: true, apology: true, hedging: true, echo: true },
      },
      {
        text: "Switch to LOCAL mode in the VS Code extension. It has browser tools.",
        passes: { negation: true, localMode: true, actionable: false, apology: true, hedging: true, echo: true },
      },
      {
        text: "I cannot open a browser. Try LOCAL mode.",
        passes: { negation: false, localMode: true, actionable: false, apology: true, hedging: true, echo: true },
      },
      {
        text: "What were you hoping to do in the browser? I can help with patients.",
        passes: { negation: true, localMode: false, actionable: false, apology: true, hedging: true, echo: true },
      },
    ];

    responses.forEach(({ text, passes }, i) => {
      it(`response ${i + 1}: "${text.substring(0, 50)}..."`, () => {
        expect(!hasNegationLead(text)).toBe(passes.negation);
        expect(mentionsLocalMode(text)).toBe(passes.localMode);
        expect(isActionable(text)).toBe(passes.actionable);
        expect(!hasExcessiveApology(text)).toBe(passes.apology);
        expect(!hasHedging(text)).toBe(passes.hedging);
        expect(!hasQuestionEcho(text)).toBe(passes.echo);
      });
    });
  });

  describe("action_request responses", () => {
    const prompt = "fix deploy error";

    const responses = [
      {
        text: "What error do you see in the build log?",
        valid: true,
      },
      {
        text: "Fixed the missing env var. Deploy is READY.",
        valid: true,
      },
      {
        text: "Would you like me to fix this error?",
        valid: false, // permission-seeking
      },
      {
        text: "I think the issue might be with your configuration. It seems like there could be a problem.",
        valid: false, // hedging
      },
    ];

    responses.forEach(({ text, valid }, i) => {
      it(`response ${i + 1} valid=${valid}: "${text.substring(0, 50)}..."`, () => {
        const issues = [];
        if (hasNegationLead(text)) issues.push("negation");
        if (isPermissionSeeking(text)) issues.push("permission-seeking");
        if (hasHedging(text)) issues.push("hedging");
        if (hasExcessiveApology(text)) issues.push("apology");
        if (hasQuestionEcho(text)) issues.push("echo");

        if (valid) {
          expect(issues).toHaveLength(0);
        } else {
          expect(issues.length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe("capability_query responses", () => {
    it("positive answer passes all rules", () => {
      const response = "Yes! I have tools for patient management, scheduling, clinical notes, communications, billing, and reports. What would you like to do?";
      expect(hasNegationLead(response)).toBe(false);
      expect(isExcessivelyVerbose(response, 4)).toBe(false);
      expect(hasHedging(response)).toBe(false);
    });

    it("denial fails", () => {
      const response = "I don't have access to many tools. I'm limited in what I can do.";
      expect(hasNegationLead(response)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════
// 8. REGRESSION: ALL APR 15 FAILURES
// ═══════════════════════════════════════════════════════

describe("Regression: Apr 15 Failures", () => {
  const failures = [
    {
      prompt: "open browser with my vercel logs",
      badResponse: "I can't directly open a browser on your machine, but you can easily access your Vercel logs by navigating to your project dashboard.",
      goodResponse: "Your Vercel logs: https://vercel.com/dashboard/deployments. To open automatically, switch to LOCAL mode in VS Code (Cmd+Shift+P). What deploy are you checking?",
      rules: ["negation", "tool_redirect"],
    },
    {
      prompt: "open browser i logged in to vercel, fix deploy error",
      badResponse: "I cannot directly open a browser or log in for you. To help fix the Vercel deploy error, please tell me what error message you are seeing.",
      goodResponse: "Switch to LOCAL mode in VS Code (Cmd+Shift+P) to open browser and fix the deploy. What error message do you see in the build log?",
      rules: ["negation", "tool_redirect"],
    },
    {
      prompt: "open browser fix vercel deploy error, prompt for login if needed",
      badResponse: "I cannot directly open a browser or log in for you. To help fix the Vercel deploy error, please tell me what error message you are seeing in the Vercel build log.",
      goodResponse: "Switch to LOCAL mode in VS Code (Cmd+Shift+P) — it will launch a browser, handle login, and check deploy logs. What project are you deploying?",
      rules: ["negation", "tool_redirect"],
    },
    {
      prompt: "open browser",
      badResponse: "What were you hoping to do in the browser? I can help with tasks like managing patients, scheduling, or generating reports.",
      goodResponse: "Switch to LOCAL mode in VS Code (Cmd+Shift+P). LOCAL mode launches a Chromium browser with full automation. What site do you need to open?",
      rules: ["tool_redirect"],
    },
    {
      prompt: "fix vercel error",
      badResponse: "I can help you diagnose that Vercel deploy error.\n\nTo start, please check the deploy logs directly on your Vercel dashboard. Look for specific error messages there. Common issues include missing environment variables, incorrect build commands, or dependency problems.\n\nFor hands-on debugging, if you're using the Synalux VS Code extension, you can access terminal and browser tools directly within its local mode.",
      goodResponse: "What error do you see in the Vercel build log?",
      rules: ["verbose"],
    },
  ];

  failures.forEach(({ prompt, badResponse, goodResponse, rules }, i) => {
    describe(`Failure ${i + 1}: "${prompt}"`, () => {
      it("bad response fails at least one rule", () => {
        const issues: string[] = [];
        if (hasNegationLead(badResponse)) issues.push("negation");
        if (rules.includes("tool_redirect") && !mentionsLocalMode(badResponse)) issues.push("no_local_mode");
        if (isExcessivelyVerbose(badResponse, prompt.split(/\s+/).length)) issues.push("verbose");
        expect(issues.length).toBeGreaterThan(0);
      });

      it("good response passes all rules", () => {
        expect(hasNegationLead(goodResponse)).toBe(false);
        if (rules.includes("tool_redirect")) {
          expect(mentionsLocalMode(goodResponse)).toBe(true);
        }
        expect(isExcessivelyVerbose(goodResponse, prompt.split(/\s+/).length)).toBe(false);
        expect(hasExcessiveApology(goodResponse)).toBe(false);
        expect(hasHedging(goodResponse)).toBe(false);
      });
    });
  });
});
