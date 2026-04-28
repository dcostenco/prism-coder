/**
 * v12.5: Cloud-Delegated Dark Factory Pipelines
 *
 * Remote agent execution with Prism memory injection over HTTP.
 * Delegates compute-intensive tasks to cloud agents while
 * maintaining full memory context.
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface DelegateConfig {
    endpoint: string;
    apiKey: string;
    maxConcurrent: number;
    timeout: number;
    enabled: boolean;
}

export interface DelegateTask {
    id: string;
    type: "build" | "test" | "deploy" | "analyze" | "transform" | "custom";
    project: string;
    payload: Record<string, unknown>;
    memoryContext?: MemoryInjection;
    priority: "low" | "normal" | "high" | "critical";
    createdAt: string;
    status: DelegateStatus;
    result?: DelegateResult;
}

export type DelegateStatus =
    | "queued"
    | "dispatched"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout";

export interface MemoryInjection {
    project: string;
    handoff?: Record<string, unknown>;
    recentLedger?: Array<{ summary: string; decisions?: string[] }>;
    contextLevel: "quick" | "standard" | "deep";
}

export interface DelegateResult {
    success: boolean;
    output: string;
    artifacts?: string[];
    memoryUpdates?: Array<{ summary: string; files_changed?: string[] }>;
    durationMs: number;
    error?: string;
}

// ─── State ───────────────────────────────────────────────────

let config: DelegateConfig = {
    endpoint: "https://cloud.synalux.ai/api/v1/darkfactory",
    apiKey: "",
    maxConcurrent: 5,
    timeout: 300_000, // 5 minutes
    enabled: false,
};

const activeTasks = new Map<string, DelegateTask>();
const taskHistory: DelegateTask[] = [];

export function configureDelegate(updates: Partial<DelegateConfig>): void {
    config = { ...config, ...updates };
    debugLog(`Cloud Delegate: Configured → ${config.endpoint}`);
}

export function getDelegateConfig(): Omit<DelegateConfig, "apiKey"> & { apiKey: string } {
    return { ...config, apiKey: config.apiKey ? "***" : "" };
}

// ─── Task Management ─────────────────────────────────────────

function generateTaskId(): string {
    return `dt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new delegate task.
 */
export function createTask(
    type: DelegateTask["type"],
    project: string,
    payload: Record<string, unknown>,
    memoryContext?: MemoryInjection,
    priority: DelegateTask["priority"] = "normal",
): DelegateTask {
    const task: DelegateTask = {
        id: generateTaskId(),
        type,
        project,
        payload,
        memoryContext,
        priority,
        createdAt: new Date().toISOString(),
        status: "queued",
    };

    activeTasks.set(task.id, task);
    debugLog(`Cloud Delegate: Created task ${task.id} (${type}) for project '${project}'`);
    return task;
}

/**
 * Dispatch a task to the cloud endpoint.
 */
export async function dispatchTask(taskId: string): Promise<DelegateTask> {
    const task = activeTasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);

    if (!config.enabled) {
        task.status = "failed";
        task.result = { success: false, output: "", durationMs: 0, error: "Cloud delegate is not enabled" };
        return task;
    }

    // Check concurrency limit
    const running = Array.from(activeTasks.values()).filter(t => t.status === "running");
    if (running.length >= config.maxConcurrent) {
        debugLog(`Cloud Delegate: Concurrency limit reached (${running.length}/${config.maxConcurrent}), task ${taskId} stays queued`);
        return task;
    }

    task.status = "dispatched";

    try {
        const start = Date.now();

        const response = await fetch(`${config.endpoint}/tasks`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${config.apiKey}`,
                "Content-Type": "application/json",
                "X-Prism-Version": "12.5.0",
            },
            body: JSON.stringify({
                id: task.id,
                type: task.type,
                project: task.project,
                payload: task.payload,
                memoryContext: task.memoryContext,
                priority: task.priority,
            }),
            signal: AbortSignal.timeout(config.timeout),
        });

        const data = await response.json() as any;
        const durationMs = Date.now() - start;

        if (response.ok) {
            task.status = "completed";
            task.result = {
                success: true,
                output: data.output || "",
                artifacts: data.artifacts,
                memoryUpdates: data.memoryUpdates,
                durationMs,
            };
        } else {
            task.status = "failed";
            task.result = {
                success: false,
                output: "",
                durationMs,
                error: data.error || `HTTP ${response.status}`,
            };
        }
    } catch (err) {
        task.status = "failed";
        task.result = {
            success: false,
            output: "",
            durationMs: 0,
            error: `Dispatch error: ${err}`,
        };
    }

    // Move to history
    taskHistory.push({ ...task });
    activeTasks.delete(taskId);

    debugLog(`Cloud Delegate: Task ${taskId} → ${task.status}`);
    return task;
}

/**
 * Cancel an active task.
 */
export function cancelTask(taskId: string): boolean {
    const task = activeTasks.get(taskId);
    if (!task) return false;

    task.status = "cancelled";
    taskHistory.push({ ...task });
    activeTasks.delete(taskId);

    debugLog(`Cloud Delegate: Cancelled task ${taskId}`);
    return true;
}

/**
 * Get task status.
 */
export function getTaskStatus(taskId: string): DelegateTask | undefined {
    return activeTasks.get(taskId) || taskHistory.find(t => t.id === taskId);
}

/**
 * List all active tasks.
 */
export function listActiveTasks(): DelegateTask[] {
    return Array.from(activeTasks.values());
}

/**
 * Get task history (last N tasks).
 */
export function getTaskHistory(limit: number = 20): DelegateTask[] {
    return taskHistory.slice(-limit);
}

/**
 * Get delegate status summary.
 */
export function getStatus(): {
    enabled: boolean;
    activeTasks: number;
    maxConcurrent: number;
    totalCompleted: number;
    totalFailed: number;
} {
    return {
        enabled: config.enabled,
        activeTasks: activeTasks.size,
        maxConcurrent: config.maxConcurrent,
        totalCompleted: taskHistory.filter(t => t.status === "completed").length,
        totalFailed: taskHistory.filter(t => t.status === "failed").length,
    };
}

debugLog("v12.5: Cloud delegate loaded");
