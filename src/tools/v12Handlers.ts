/**
 * v12 Tool Handlers
 *
 * Handlers for the 6 new MCP tools added in v12.1 and v12.2:
 * - onboarding_wizard (v12.1)
 * - extract_entities (v12.1)
 * - api_analytics (v12.2)
 * - backup_database (v12.2)
 * - configure_notifications (v12.2)
 * - query_memory_natural (v12.2)
 */

import { debugLog } from "../utils/logger.js";
import {
    isOnboardingWizardArgs,
    isExtractEntitiesArgs,
    isBackupDatabaseArgs,
    isConfigureNotificationsArgs,
    isQueryMemoryNaturalArgs,
} from "./sessionMemoryDefinitions.js";

// ─── Onboarding Wizard Handler ───────────────────────────────

export async function onboardingWizardHandler(args: Record<string, unknown>) {
    if (!isOnboardingWizardArgs(args)) {
        return {
            content: [{ type: "text", text: "Invalid arguments for onboarding_wizard." }],
            isError: true,
        };
    }

    const { step, responses } = args;

    try {
        const wizard = await import("../onboarding/wizard.js");

        if (step === undefined || step === null) {
            // Create a new wizard state and return the first step
            const state = wizard.createWizardState();
            const content = wizard.getWizardStepContent(state.currentStep);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "in_progress",
                        current_step: state.currentStep,
                        total_steps: 8,
                        step: content,
                        summary: wizard.getWizardSummary(state),
                    }, null, 2),
                }],
            };
        }

        // Advance to next step
        const state = wizard.createWizardState();
        // Advance to the requested step position
        let currentState = state;
        for (let i = 0; i < (step as number); i++) {
            currentState = wizard.advanceWizard(currentState);
        }

        if (wizard.isWizardComplete(currentState)) {
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "completed",
                        message: "Onboarding complete! Prism is ready to use.",
                        summary: wizard.getWizardSummary(currentState),
                    }, null, 2),
                }],
            };
        }

        // Get content for current step
        const content = wizard.getWizardStepContent(
            currentState.currentStep,
            currentState,
        );

        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: "in_progress",
                    current_step: currentState.currentStep,
                    step: content,
                    summary: wizard.getWizardSummary(currentState),
                }, null, 2),
            }],
        };
    } catch (err) {
        debugLog(`onboarding_wizard error: ${err}`);
        return {
            content: [{ type: "text", text: `Onboarding wizard error: ${err}` }],
            isError: true,
        };
    }
}

// ─── Extract Entities (NER) Handler ──────────────────────────

export async function extractEntitiesHandler(args: Record<string, unknown>) {
    if (!isExtractEntitiesArgs(args)) {
        return {
            content: [{ type: "text", text: "Invalid arguments for extract_entities. Required: text (string)." }],
            isError: true,
        };
    }

    const { text, use_llm } = args;

    try {
        const { extractEntities } = await import("../utils/nerExtractor.js");
        const result = await extractEntities(
            text as string,
            { enabled: (use_llm as boolean) || false },
        );

        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: "ok",
                    entity_count: result.entities.length,
                    processing_ms: result.processingMs,
                    entities: result.entities,
                }, null, 2),
            }],
        };
    } catch (err) {
        debugLog(`extract_entities error: ${err}`);
        return {
            content: [{ type: "text", text: `Entity extraction error: ${err}` }],
            isError: true,
        };
    }
}

// ─── API Analytics Handler ───────────────────────────────────

export async function apiAnalyticsHandler(args: Record<string, unknown>) {
    const { action, project, days } = args as {
        action?: string;
        project?: string;
        days?: number;
    };

    try {
        const analytics = await import("../utils/analytics.js");

        if (action === "dashboard" || !action) {
            const dashboard = await analytics.getSystemAnalytics(days || 30);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "ok",
                        period_days: days || 30,
                        dashboard,
                    }, null, 2),
                }],
            };
        }

        if (action === "project" && project) {
            const projectStats = await analytics.getProjectAnalytics(project, days || 30);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "ok",
                        project,
                        period_days: days || 30,
                        stats: projectStats,
                    }, null, 2),
                }],
            };
        }

        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: "ok",
                    message: "Use action='dashboard' for aggregate stats or action='project' with project='name' for per-project stats.",
                }, null, 2),
            }],
        };
    } catch (err) {
        debugLog(`api_analytics error: ${err}`);
        return {
            content: [{ type: "text", text: `Analytics error: ${err}` }],
            isError: true,
        };
    }
}

// ─── Backup Database Handler ─────────────────────────────────

export async function backupDatabaseHandler(args: Record<string, unknown>) {
    if (!isBackupDatabaseArgs(args)) {
        return {
            content: [{ type: "text", text: "Invalid arguments for backup_database. Required: action (string)." }],
            isError: true,
        };
    }

    const { action, backup_path } = args;

    try {
        const backup = await import("../utils/backup.js");
        // Resolve the Prism DB path from env or default
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const dbPath = process.env.PRISM_DB_PATH || join(homedir(), ".prism", "memory.db");

        switch (action) {
            case "create": {
                const result = await backup.createBackup(dbPath);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: result.success ? "ok" : "error", ...result }, null, 2),
                    }],
                };
            }
            case "list": {
                const backups = backup.listBackups(dbPath);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "ok",
                            backup_count: backups.length,
                            backups: backups.map(b => ({
                                path: b.path,
                                size_kb: (b.sizeBytes / 1024).toFixed(1),
                                age_hours: (b.ageMs / 3600000).toFixed(1),
                                created: b.createdAt.toISOString(),
                            })),
                        }, null, 2),
                    }],
                };
            }
            case "restore": {
                if (!backup_path) {
                    return {
                        content: [{ type: "text", text: "backup_path is required for restore action." }],
                        isError: true,
                    };
                }
                const result = await backup.restoreFromBackup(dbPath, backup_path as string);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: result.success ? "ok" : "error", ...result }, null, 2),
                    }],
                };
            }
            case "configure": {
                const config = backup.getBackupConfig();
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: "ok", config }, null, 2),
                    }],
                };
            }
            default:
                return {
                    content: [{ type: "text", text: `Unknown backup action: ${action}. Use: create, list, restore, configure.` }],
                    isError: true,
                };
        }
    } catch (err) {
        debugLog(`backup_database error: ${err}`);
        return {
            content: [{ type: "text", text: `Backup error: ${err}` }],
            isError: true,
        };
    }
}

// ─── Configure Notifications Handler ─────────────────────────

export async function configureNotificationsHandler(args: Record<string, unknown>) {
    if (!isConfigureNotificationsArgs(args)) {
        return {
            content: [{ type: "text", text: "Invalid arguments for configure_notifications. Required: action (string)." }],
            isError: true,
        };
    }

    const { action, config, test_message } = args;

    try {
        const notifier = await import("../utils/notifier.js");

        switch (action) {
            case "status": {
                const currentConfig = notifier.getNotificationConfig();
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: "ok", config: currentConfig }, null, 2),
                    }],
                };
            }
            case "add_channel": {
                if (!config) {
                    return {
                        content: [{ type: "text", text: "config object is required for add_channel action." }],
                        isError: true,
                    };
                }
                // Add channel by updating the config with new channels array entry
                const currentConfig = notifier.getNotificationConfig();
                const channels = [...currentConfig.channels, config as any];
                notifier.configureNotifications({ channels });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: "ok", message: "Channel added.", channels: notifier.getNotificationConfig().channels }, null, 2),
                    }],
                };
            }
            case "remove_channel": {
                if (!config || !(config as any).url) {
                    return {
                        content: [{ type: "text", text: "config.url is required for remove_channel action." }],
                        isError: true,
                    };
                }
                const currentConfig2 = notifier.getNotificationConfig();
                const filteredChannels = currentConfig2.channels.filter(
                    (ch) => ch.url !== (config as any).url
                );
                notifier.configureNotifications({ channels: filteredChannels });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: "ok", message: "Channel removed.", remaining: filteredChannels.length }, null, 2),
                    }],
                };
            }
            case "test": {
                const message = (test_message as string) || "Test notification from Prism MCP";
                const result = await notifier.notify(
                    "health_degradation",
                    "info",
                    "Test Notification",
                    message,
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: "ok", message: "Test notification sent.", ...result }, null, 2),
                    }],
                };
            }
            default:
                return {
                    content: [{ type: "text", text: `Unknown notification action: ${action}. Use: status, add_channel, remove_channel, test.` }],
                    isError: true,
                };
        }
    } catch (err) {
        debugLog(`configure_notifications error: ${err}`);
        return {
            content: [{ type: "text", text: `Notification error: ${err}` }],
            isError: true,
        };
    }
}

// ─── Natural Language Memory Query Handler ───────────────────

export async function queryMemoryNaturalHandler(args: Record<string, unknown>) {
    if (!isQueryMemoryNaturalArgs(args)) {
        return {
            content: [{ type: "text", text: "Invalid arguments for query_memory_natural. Required: query (string)." }],
            isError: true,
        };
    }

    const { query, project } = args;

    try {
        const nlQuery = await import("../utils/nlQuery.js");

        if (project) {
            // Attempt full end-to-end query with project context
            const result = await nlQuery.executeNLQuery(
                query as string,
                project as string,
            );
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "ok",
                        ...result,
                    }, null, 2),
                }],
            };
        }

        // Parse-only mode (no project context to execute against)
        const parsed = nlQuery.parseNLQuery(query as string);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: "ok",
                    ...parsed,
                    hint: "Provide a 'project' parameter to execute the query against memory.",
                }, null, 2),
            }],
        };
    } catch (err) {
        debugLog(`query_memory_natural error: ${err}`);
        return {
            content: [{ type: "text", text: `Natural language query error: ${err}` }],
            isError: true,
        };
    }
}
