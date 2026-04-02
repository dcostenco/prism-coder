/**
 * Pipeline Handlers (v7.3 — Dark Factory)
 *
 * MCP tool handlers for managing autonomous pipeline lifecycle:
 *   - session_start_pipeline: Create and enqueue a new pipeline
 *   - session_check_pipeline_status: Poll pipeline progress
 *   - session_abort_pipeline: Kill a running pipeline
 *
 * These handlers follow the exact same CallToolResult pattern as
 * all other tools in /tools/*.ts.
 */

import { randomUUID } from 'crypto';
import { getStorage } from '../storage/index.js';
import { PRISM_USER_ID } from '../config.js';
import { getSettingSync } from '../storage/configStorage.js';
import type { PipelineState } from '../storage/interface.js';
import type { PipelineSpec } from '../darkfactory/schema.js';
import {
  type StartPipelineArgs,
  type CheckPipelineStatusArgs,
  type AbortPipelineArgs,
  isStartPipelineArgs,
  isCheckPipelineStatusArgs,
  isAbortPipelineArgs,
} from './pipelineDefinitions.js';
import { debugLog } from '../utils/logger.js';

// ─── Start Pipeline Handler ─────────────────────────────────

export async function sessionStartPipelineHandler(args: unknown) {
  if (!isStartPipelineArgs(args)) {
    return {
      content: [{ type: "text" as const, text: "❌ Invalid arguments. Required: project (string), objective (string). Optional: working_directory, max_iterations (1-10), context_files, model_override." }],
      isError: true,
    };
  }

  const { project, objective, working_directory, max_iterations, context_files, model_override } = args;

  // Resolve working directory: explicit arg > dashboard repo_path > reject
  let resolvedWorkDir = working_directory;
  if (!resolvedWorkDir) {
    resolvedWorkDir = getSettingSync("repo_path", "");
    if (!resolvedWorkDir) {
      return {
        content: [{ type: "text" as const, text: "❌ No working_directory provided and no repo_path configured for this project. Either pass working_directory or configure repo_path in the dashboard." }],
        isError: true,
      };
    }
  }

  const pipelineId = randomUUID();
  const now = new Date().toISOString();

  const spec: PipelineSpec = {
    objective,
    maxIterations: Math.min(max_iterations ?? 3, 10),
    workingDirectory: resolvedWorkDir,
    contextFiles: context_files,
    modelOverride: model_override,
  };

  const pipelineState: PipelineState = {
    id: pipelineId,
    project,
    user_id: PRISM_USER_ID,
    status: 'RUNNING',
    current_step: 'INIT',
    iteration: 0,
    spec: JSON.stringify(spec),
    error: null,
    started_at: now,
    updated_at: now,
    last_heartbeat: now,
  };

  try {
    const storage = await getStorage();
    await storage.savePipeline(pipelineState);

    debugLog(`[PipelineHandler] Pipeline ${pipelineId} created for project=${project} objective="${objective.slice(0, 80)}"`);

    return {
      content: [{
        type: "text" as const,
        text: [
          `✅ Dark Factory pipeline started.`,
          ``,
          `**Pipeline ID:** \`${pipelineId}\``,
          `**Project:** ${project}`,
          `**Objective:** ${objective.slice(0, 200)}`,
          `**Working Directory:** ${resolvedWorkDir}`,
          `**Max Iterations:** ${spec.maxIterations}`,
          `**Status:** RUNNING`,
          ``,
          `The pipeline is now executing autonomously in the background.`,
          `Use \`session_check_pipeline_status\` with the pipeline ID to poll for results.`,
          `Use \`session_abort_pipeline\` to cancel the pipeline.`,
        ].join('\n'),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog(`[PipelineHandler] Failed to create pipeline: ${msg}`);
    return {
      content: [{ type: "text" as const, text: `❌ Failed to create pipeline: ${msg}` }],
      isError: true,
    };
  }
}

// ─── Check Pipeline Status Handler ──────────────────────────

export async function sessionCheckPipelineStatusHandler(args: unknown) {
  if (!isCheckPipelineStatusArgs(args)) {
    return {
      content: [{ type: "text" as const, text: "❌ Invalid arguments. Required: pipeline_id (string). Optional: project." }],
      isError: true,
    };
  }

  const { pipeline_id, project } = args;

  try {
    const storage = await getStorage();
    const pipeline = await storage.getPipeline(pipeline_id, PRISM_USER_ID);

    if (!pipeline) {
      return {
        content: [{ type: "text" as const, text: `❌ Pipeline \`${pipeline_id}\` not found.` }],
        isError: true,
      };
    }

    // Project filter — if specified, ensure pipeline belongs to the project
    if (project && pipeline.project !== project) {
      return {
        content: [{ type: "text" as const, text: `❌ Pipeline \`${pipeline_id}\` does not belong to project "${project}".` }],
        isError: true,
      };
    }

    // Parse spec for display (safe — we handle parse failures)
    let objective = 'Unknown';
    let maxIter = '?';
    try {
      const spec: PipelineSpec = JSON.parse(pipeline.spec);
      objective = spec.objective.slice(0, 200);
      maxIter = String(spec.maxIterations);
    } catch {
      objective = '(spec corrupted)';
    }

    const isTerminal = ['COMPLETED', 'FAILED', 'ABORTED'].includes(pipeline.status);
    const emoji = pipeline.status === 'COMPLETED' ? '✅' :
                  pipeline.status === 'FAILED' ? '❌' :
                  pipeline.status === 'ABORTED' ? '🛑' :
                  pipeline.status === 'RUNNING' ? '⏳' : '📋';

    const lines = [
      `${emoji} **Pipeline Status: ${pipeline.status}**`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| **ID** | \`${pipeline.id}\` |`,
      `| **Project** | ${pipeline.project} |`,
      `| **Objective** | ${objective} |`,
      `| **Current Step** | ${pipeline.current_step} |`,
      `| **Iteration** | ${pipeline.iteration} / ${maxIter} |`,
      `| **Started** | ${pipeline.started_at} |`,
      `| **Last Updated** | ${pipeline.updated_at} |`,
      `| **Last Heartbeat** | ${pipeline.last_heartbeat || 'N/A'} |`,
    ];

    if (pipeline.error) {
      lines.push(`| **Error** | ${pipeline.error.slice(0, 500)} |`);
    }

    if (!isTerminal) {
      lines.push(``, `*Pipeline is still running. Poll again in 30-60 seconds.*`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join('\n') }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `❌ Failed to check pipeline status: ${msg}` }],
      isError: true,
    };
  }
}

// ─── Abort Pipeline Handler ─────────────────────────────────

export async function sessionAbortPipelineHandler(args: unknown) {
  if (!isAbortPipelineArgs(args)) {
    return {
      content: [{ type: "text" as const, text: "❌ Invalid arguments. Required: pipeline_id (string)." }],
      isError: true,
    };
  }

  const { pipeline_id } = args;

  try {
    const storage = await getStorage();
    const pipeline = await storage.getPipeline(pipeline_id, PRISM_USER_ID);

    if (!pipeline) {
      return {
        content: [{ type: "text" as const, text: `❌ Pipeline \`${pipeline_id}\` not found.` }],
        isError: true,
      };
    }

    // Already terminal?
    if (['COMPLETED', 'FAILED', 'ABORTED'].includes(pipeline.status)) {
      return {
        content: [{ type: "text" as const, text: `ℹ️ Pipeline \`${pipeline_id}\` is already in terminal state: **${pipeline.status}**. No action needed.` }],
      };
    }

    // Abort — the status guard + kill switch in runner.ts will handle the rest
    await storage.savePipeline({
      ...pipeline,
      status: 'ABORTED',
      error: 'Manually aborted by user via session_abort_pipeline.',
    });

    debugLog(`[PipelineHandler] Pipeline ${pipeline_id} aborted by user.`);

    return {
      content: [{
        type: "text" as const,
        text: `🛑 Pipeline \`${pipeline_id}\` has been **ABORTED**.\n\nThe background runner will stop processing this pipeline on the next tick.`,
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `❌ Failed to abort pipeline: ${msg}` }],
      isError: true,
    };
  }
}
