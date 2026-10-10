import path from 'node:path';
import type { StartPipelineArgs } from '../tools/pipelineDefinitions.js';

const MAX_FILES = 2;
const MAX_PROMPT_CHARS = 4096;
const IMPLEMENTATION_REQUEST = /^(?:(?:please|can you|could you|i want you to|i need you to)\s+)*(?:fix|implement|add|update|create|write|repair)\b/i;
const CLINICAL_REQUEST = /\b(?:bcba|bip|fba|aba|clinical|patient|client notes|behavio(?:u)?r (?:support|intervention|plan|assessment|analysis|reduction)|operational definition|fct|dra|dro|ncr|functional (?:analysis|assessment|communication training)|teaching procedure|reinforcement schedule|differential reinforcement|token economy|antecedent strateg(?:y|ies)|task analysis|preference assessment|sensory supports?|skill acquisition|prompting hierarchy|consequence (?:strateg(?:y|ies)|section)|crisis|restraint|seclusion|self[- ]injury|elopement|aggression)\b/i;
const RESERVED_REQUEST = /\b(?:deploy|publish|push|commit|production|credentials?|secrets?|payments?|billing|authentication|authorization|security|migration|delete|drop|truncate|architecture|redesign|entire codebase|entire repo)\b/i;
const CODE_FILES = /(?:^|[\s`"'(])([A-Za-z0-9_./-]+\.(?:cjs|mjs|js|ts|tsx|py|go|rs|swift|rb|java|kt|cs))\b/g;
const CODE_EXTENSION = /\.(?:cjs|mjs|js|ts|tsx|py|go|rs|swift|rb|java|kt|cs)$/;
const VERIFY_REQUEST = /\b(?:run|verify|test|check|validate)\b/i;
const NODE_TEST_COMMAND = /\b(node\s+--test\s+[A-Za-z0-9_./-]+\.(?:cjs|mjs|js|ts))\b/;
const MESSAGES = {
  clinical: 'Clinical and non-coding BCBA requests stay with the clinical host/skill route; they do not start a coding pipeline.',
  reserved: 'This request requires host judgment or external/destructive operations.',
  ordinary: 'No bounded implementation request identified.',
  files: 'Factory needs one or two concrete code files within the workspace.',
  writes: 'Factory write paths must be a nonempty subset of the validated concrete code files.',
  verify: 'Factory needs an explicit verification outcome.',
  command: 'The host must supply the repository verification command before starting Factory.',
  disabled: 'Factory is disabled for this MCP startup.',
  context: 'The host must supply the project and absolute working_directory before starting Factory.',
  paid: 'Paid Factory execution is unavailable until Portal pipeline and verification APIs and their schema are ready.',
  candidate: 'Bounded implementation with concrete files and verification; the host should call the recommended pipeline tool automatically.',
} as const;

export interface FactoryPromptContext {
  enabled: boolean;
  project?: string;
  working_directory?: string;
  files_involved?: string[];
  test_command?: string;
  storage_backend?: string;
  factory_ready?: boolean;
  allowed_write_paths?: string[];
}

export interface FactoryPromptRoute {
  target: 'factory' | 'host';
  candidate: boolean;
  reason: string;
  recommended_tool: 'session_start_pipeline' | null;
  recommended_args?: StartPipelineArgs;
}

/** Routing is read-only. Pipeline creation remains a separate, side-effecting MCP call. */
export function routeFactoryPrompt(prompt: string, context: FactoryPromptContext): FactoryPromptRoute {
  const host = (reason: string, candidate = false): FactoryPromptRoute => ({ target: 'host', candidate, reason, recommended_tool: null });
  if (CLINICAL_REQUEST.test(prompt)) return host(MESSAGES.clinical);
  if (RESERVED_REQUEST.test(prompt)) return host(MESSAGES.reserved);
  if (!IMPLEMENTATION_REQUEST.test(prompt.trim()) || prompt.length > MAX_PROMPT_CHARS) return host(MESSAGES.ordinary);
  const files = [...new Set(context.files_involved ?? [...prompt.matchAll(CODE_FILES)].map(match => match[1]))];
  if (files.length === 0 || files.length > MAX_FILES || files.some(file => !CODE_EXTENSION.test(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) return host(MESSAGES.files);
  const writePaths = [...new Set(context.allowed_write_paths ?? files)];
  if (!writePaths.length || writePaths.some(file => path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !files.includes(file))) return host(MESSAGES.writes);
  if (!context.test_command && !VERIFY_REQUEST.test(prompt)) return host(MESSAGES.verify);
  if (!context.enabled) return host(MESSAGES.disabled, true);
  if (context.factory_ready === false || context.storage_backend === 'unavailable' || (context.storage_backend === 'synalux' && context.factory_ready !== true)) return host(MESSAGES.paid, true);
  if (!context.project?.trim() || !context.working_directory || !path.isAbsolute(context.working_directory)) return host(MESSAGES.context, true);
  const testCommand = context.test_command || NODE_TEST_COMMAND.exec(prompt)?.[1];
  if (!testCommand) return host(MESSAGES.command, true);
  const objective = `${prompt}\nVerification command: ${testCommand}`;
  return {
    target: 'factory', candidate: true, reason: MESSAGES.candidate,
    recommended_tool: 'session_start_pipeline',
    recommended_args: { project: context.project.trim(), objective, working_directory: context.working_directory, context_files: files, max_iterations: 3, test_command: testCommand, allowed_write_paths: writePaths },
  };
}

export function formatFactoryPromptRoute(route: FactoryPromptRoute): string {
  return `<prism_factory_route>${JSON.stringify(route)}</prism_factory_route>`;
}
