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

// ═══════════════════════════════════════════════════════════════
// v12.3: Team Collaboration & RBAC Handlers
// ═══════════════════════════════════════════════════════════════

export async function manageRbacHandler(args: Record<string, unknown>) {
    const { action, project, role, user_id, permission, permissions } = args as {
        action: string; project?: string; role?: string; user_id?: string;
        permission?: string; permissions?: string[];
    };

    try {
        const rbac = await import("../utils/rbac.js");

        switch (action) {
            case "create_role": {
                if (!role || !permissions) {
                    return { content: [{ type: "text", text: "role and permissions are required for create_role." }], isError: true };
                }
                const permObj = { read: permissions.includes("read"), write: permissions.includes("write"), delete: permissions.includes("delete"), admin: permissions.includes("admin") };
                const created = rbac.createCustomRole(role, role, permObj);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: `Role '${role}' created.`, role: created }, null, 2) }] };
            }
            case "delete_role": {
                if (!role) return { content: [{ type: "text", text: "role is required." }], isError: true };
                const deleted = rbac.deleteCustomRole(role);
                return { content: [{ type: "text", text: JSON.stringify({ status: deleted ? "ok" : "error", message: deleted ? `Role '${role}' deleted.` : `Role '${role}' not found or is builtin.` }, null, 2) }] };
            }
            case "assign_role": {
                if (!user_id || !role || !project) return { content: [{ type: "text", text: "user_id, role, and project are required." }], isError: true };
                const assignment = rbac.assignRole(user_id, role, project, "system");
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: `Role '${role}' assigned to user '${user_id}' on project '${project}'.`, assignment }, null, 2) }] };
            }
            case "revoke_role": {
                if (!user_id || !role || !project) return { content: [{ type: "text", text: "user_id, role, and project are required." }], isError: true };
                const revoked = rbac.revokeRole(user_id, role, project);
                return { content: [{ type: "text", text: JSON.stringify({ status: revoked ? "ok" : "error", message: revoked ? `Role revoked for user '${user_id}' on project '${project}'.` : "Assignment not found." }, null, 2) }] };
            }
            case "check_permission": {
                if (!user_id || !permission || !project) return { content: [{ type: "text", text: "user_id, permission, and project are required." }], isError: true };
                const result = rbac.checkAccess(user_id, project, permission as any);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...result }, null, 2) }] };
            }
            case "list_roles": {
                const roles = rbac.listRoles();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", roles }, null, 2) }] };
            }
            case "list_assignments": {
                if (!project) return { content: [{ type: "text", text: "project is required." }], isError: true };
                const members = rbac.getProjectMembers(project);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", project, assignments: members }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown RBAC action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`manage_rbac error: ${err}`);
        return { content: [{ type: "text", text: `RBAC error: ${err}` }], isError: true };
    }
}

export async function encryptedSyncHandler(args: Record<string, unknown>) {
    const { action, project, peer_url, encryption_key } = args as {
        action: string; project?: string; peer_url?: string; encryption_key?: string;
    };

    try {
        const sync = await import("../sync/encryptedSync.js");

        switch (action) {
            case "list_peers": {
                const peers = sync.listPeers();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", peers }, null, 2) }] };
            }
            case "register_peer": {
                if (!peer_url) return { content: [{ type: "text", text: "peer_url is required." }], isError: true };
                const peerId = `peer_${Date.now()}`;
                sync.registerPeer({ id: peerId, name: peerId, publicKey: "", lastSeen: new Date().toISOString(), transport: "websocket", address: peer_url });
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: `Peer registered: ${peerId}`, peer_id: peerId }, null, 2) }] };
            }
            case "push": {
                if (!peer_url || !project || !encryption_key) return { content: [{ type: "text", text: "peer_url, project, and encryption_key are required." }], isError: true };
                const packet = await sync.prepareSyncPacket("local", peer_url, [], encryption_key);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: `Push prepared for '${project}' → ${peer_url}`, metadata: packet.metadata }, null, 2) }] };
            }
            case "status": {
                const peers = sync.listPeers();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", peer_count: peers.length, peers: peers.map(p => ({ id: p.id, name: p.name, lastSeen: p.lastSeen, transport: p.transport })) }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown sync action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`encrypted_sync error: ${err}`);
        return { content: [{ type: "text", text: `Sync error: ${err}` }], isError: true };
    }
}

// ═══════════════════════════════════════════════════════════════
// v12.4: GitHub Integration & Automation Handlers
// ═══════════════════════════════════════════════════════════════

export async function githubSyncHandler(args: Record<string, unknown>) {
    const { action, project, repo, token } = args as {
        action: string; project?: string; repo?: string; token?: string;
    };

    try {
        const gh = await import("../scm/githubSync.js");

        switch (action) {
            case "configure": {
                if (!repo || !token) return { content: [{ type: "text", text: "repo and token are required." }], isError: true };
                const [owner, repoName] = repo.includes("/") ? repo.split("/") : ["", repo];
                gh.configureGitHubSync({ owner, repo: repoName || repo, token, syncEnabled: true });
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: `GitHub sync configured for ${repo}`, config: gh.getGitHubSyncConfig() }, null, 2) }] };
            }
            case "create_issue": {
                if (!project) return { content: [{ type: "text", text: "project is required." }], isError: true };
                const issue = await gh.createIssueFromMemory("Prism Memory Sync", "Auto-synced from Prism session", project, `auto_${Date.now()}`);
                return { content: [{ type: "text", text: JSON.stringify({ status: issue ? "ok" : "error", issue }, null, 2) }] };
            }
            case "list_issues": {
                const issues = await gh.listSyncedIssues();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", count: issues.length, issues }, null, 2) }] };
            }
            case "track_pr": {
                if (!project) return { content: [{ type: "text", text: "project is required." }], isError: true };
                const prNumber = (args as any).pr_number;
                if (!prNumber) return { content: [{ type: "text", text: "pr_number is required." }], isError: true };
                const pr = await gh.trackPR(prNumber, project);
                return { content: [{ type: "text", text: JSON.stringify({ status: pr ? "ok" : "error", pr }, null, 2) }] };
            }
            case "sync_status": {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...gh.getSyncStatus() }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown GitHub sync action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`github_sync error: ${err}`);
        return { content: [{ type: "text", text: `GitHub sync error: ${err}` }], isError: true };
    }
}

export async function generateChangelogHandler(args: Record<string, unknown>) {
    const { project, from_date, to_date, format, use_llm, include_files } = args as {
        project: string; from_date?: string; to_date?: string;
        format?: string; use_llm?: boolean; include_files?: boolean;
    };

    try {
        const changelogMod = await import("../utils/changelogGenerator.js");
        const storage = await (await import("../storage/index.js")).getStorage();

        // Fetch ledger entries for the project
        const raw = await storage.getLedgerEntries({ project }) as any[];
        const entries = raw.map(e => ({
            id: e.id || "",
            summary: e.summary || "",
            decisions: e.decisions,
            todos: e.todos,
            files_changed: e.files_changed,
            created_at: e.created_at || new Date().toISOString(),
            conversation_id: e.conversation_id || "",
            project: e.project || project,
        }));
        const changelog = await changelogMod.generateChangelogWithLlm(entries, {
            project,
            fromDate: from_date,
            toDate: to_date,
            format: (format as any) || "markdown",
            useLlm: use_llm || false,
            includeFileChanges: include_files || false,
        });

        return { content: [{ type: "text", text: changelog }] };
    } catch (err) {
        debugLog(`generate_changelog error: ${err}`);
        return { content: [{ type: "text", text: `Changelog error: ${err}` }], isError: true };
    }
}

export async function generateCiPipelineHandler(args: Record<string, unknown>) {
    const { project, preset, custom_config } = args as {
        project: string; preset?: string; custom_config?: Record<string, unknown>;
    };

    try {
        const ci = await import("../scm/ciPipeline.js");

        if (preset && preset !== "custom") {
            const workflow = ci.generateFromPreset(preset, project);
            if (!workflow) {
                const presets = ci.listPresets();
                return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: `Unknown preset '${preset}'`, available: presets }, null, 2) }], isError: true };
            }
            return { content: [{ type: "text", text: JSON.stringify({ status: "ok", filename: workflow.filename, description: workflow.description, yaml: workflow.yaml }, null, 2) }] };
        }

        const presets = ci.listPresets();
        return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: "Specify a preset or custom_config.", available_presets: presets }, null, 2) }] };
    } catch (err) {
        debugLog(`generate_ci_pipeline error: ${err}`);
        return { content: [{ type: "text", text: `CI pipeline error: ${err}` }], isError: true };
    }
}

export async function memoryAttestationHandler(args: Record<string, unknown>) {
    const { action, project, entry_id } = args as {
        action: string; project: string; entry_id?: string;
    };

    try {
        const attestation = await import("../utils/memoryAttestation.js");
        const storage = await (await import("../storage/index.js")).getStorage();

        switch (action) {
            case "generate": {
                const raw = await storage.getLedgerEntries({ project });
                const entries = (raw as any[]).map(e => ({
                    id: e.id,
                    content: e.summary || "",
                    timestamp: e.created_at || new Date().toISOString(),
                }));
                const report = attestation.generateAttestationReport(project, entries);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...report }, null, 2) }] };
            }
            case "verify": {
                if (!entry_id) return { content: [{ type: "text", text: "entry_id is required for verify." }], isError: true };
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", entry_id, message: "Use the 'generate' action first to create a report, then verify individual entries." }, null, 2) }] };
            }
            case "proof": {
                if (!entry_id) return { content: [{ type: "text", text: "entry_id is required for proof." }], isError: true };
                const raw2 = await storage.getLedgerEntries({ project });
                const entries2 = (raw2 as any[]).map(e => ({
                    id: e.id,
                    hash: attestation.hashEntry(e.id, e.summary || "", e.created_at || ""),
                }));
                const proof = attestation.generateProof(entries2, entry_id);
                if (!proof) return { content: [{ type: "text", text: `Entry '${entry_id}' not found in project.` }], isError: true };
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...proof }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown attestation action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`memory_attestation error: ${err}`);
        return { content: [{ type: "text", text: `Attestation error: ${err}` }], isError: true };
    }
}

// ═══════════════════════════════════════════════════════════════
// v12.5: Cloud Runtime & Extensibility Handlers
// ═══════════════════════════════════════════════════════════════

export async function managePluginsHandler(args: Record<string, unknown>) {
    const { action, plugin_name } = args as { action: string; plugin_name?: string };

    try {
        const pm = await import("../plugins/pluginManager.js");

        switch (action) {
            case "discover": {
                const manifests = pm.discoverPlugins();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", plugins: manifests }, null, 2) }] };
            }
            case "load": {
                if (!plugin_name) return { content: [{ type: "text", text: "plugin_name is required." }], isError: true };
                const loaded = await pm.loadPlugin(plugin_name);
                return { content: [{ type: "text", text: JSON.stringify({ status: loaded.status === "error" ? "error" : "ok", plugin: loaded }, null, 2) }] };
            }
            case "unload": {
                if (!plugin_name) return { content: [{ type: "text", text: "plugin_name is required." }], isError: true };
                const unloaded = await pm.unloadPlugin(plugin_name);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", unloaded }, null, 2) }] };
            }
            case "list": {
                const plugins = pm.listPlugins();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", count: plugins.length, plugins: plugins.map(p => ({ name: p.manifest.name, version: p.manifest.version, status: p.status })) }, null, 2) }] };
            }
            case "validate": {
                if (!plugin_name) return { content: [{ type: "text", text: "plugin_name is required." }], isError: true };
                const manifests = pm.discoverPlugins();
                const target = manifests.find(m => m.name === plugin_name);
                if (!target) return { content: [{ type: "text", text: `Plugin '${plugin_name}' not found.` }], isError: true };
                const validation = pm.validateManifest(target);
                return { content: [{ type: "text", text: JSON.stringify({ status: validation.valid ? "ok" : "error", ...validation }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown plugin action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`manage_plugins error: ${err}`);
        return { content: [{ type: "text", text: `Plugin error: ${err}` }], isError: true };
    }
}

export async function synaluxProxyHandler(args: Record<string, unknown>) {
    const { action, tier, api_key, request } = args as {
        action: string; tier?: string; api_key?: string; request?: Record<string, unknown>;
    };

    try {
        const proxy = await import("../sync/synaluxProxy.js");

        switch (action) {
            case "configure": {
                const updates: Record<string, unknown> = { enabled: true };
                if (tier) updates.tier = tier;
                if (api_key) updates.apiKey = api_key;
                proxy.configureProxy(updates as any);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", config: proxy.getProxyConfig() }, null, 2) }] };
            }
            case "health": {
                const health = await proxy.healthCheck();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...health }, null, 2) }] };
            }
            case "features": {
                const features = proxy.listAvailableFeatures();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", features }, null, 2) }] };
            }
            case "status": {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", config: proxy.getProxyConfig() }, null, 2) }] };
            }
            case "request": {
                if (!request) return { content: [{ type: "text", text: "request object is required." }], isError: true };
                const result = await proxy.proxyRequest(request as any);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", httpStatus: result.status, data: result.data, latencyMs: result.latencyMs, cached: result.cached }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown proxy action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`synalux_proxy error: ${err}`);
        return { content: [{ type: "text", text: `Proxy error: ${err}` }], isError: true };
    }
}

export async function cloudDelegateHandler(args: Record<string, unknown>) {
    const { action, task_type, project, task_id, payload, priority } = args as {
        action: string; task_type?: string; project?: string; task_id?: string;
        payload?: Record<string, unknown>; priority?: string;
    };

    try {
        const delegate = await import("../darkfactory/cloudDelegate.js");

        switch (action) {
            case "create": {
                if (!task_type || !project) return { content: [{ type: "text", text: "task_type and project are required." }], isError: true };
                const task = delegate.createTask(task_type as any, project, payload || {}, undefined, (priority as any) || "normal");
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", task }, null, 2) }] };
            }
            case "dispatch": {
                if (!task_id) return { content: [{ type: "text", text: "task_id is required." }], isError: true };
                const result = await delegate.dispatchTask(task_id);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", task: result }, null, 2) }] };
            }
            case "status": {
                if (!task_id) return { content: [{ type: "text", text: "task_id is required." }], isError: true };
                const task = delegate.getTaskStatus(task_id);
                if (!task) return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", task }, null, 2) }] };
            }
            case "cancel": {
                if (!task_id) return { content: [{ type: "text", text: "task_id is required." }], isError: true };
                const cancelled = delegate.cancelTask(task_id);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", cancelled }, null, 2) }] };
            }
            case "list": {
                const tasks = delegate.listActiveTasks();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", active_tasks: tasks }, null, 2) }] };
            }
            case "history": {
                const history = delegate.getTaskHistory();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", history }, null, 2) }] };
            }
            case "configure": {
                const updates: Record<string, unknown> = { enabled: true };
                delegate.configureDelegate(updates as any);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", config: delegate.getDelegateConfig() }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown delegate action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`cloud_delegate error: ${err}`);
        return { content: [{ type: "text", text: `Cloud delegate error: ${err}` }], isError: true };
    }
}

export async function vmQuotaHandler(args: Record<string, unknown>) {
    const { action, tier, cpu_cores, ram_gb, storage_gb, platform } = args as {
        action: string; tier?: string; cpu_cores?: number; ram_gb?: number;
        storage_gb?: number; platform?: string;
    };

    try {
        const quota = await import("../vm/quotaEnforcer.js");

        switch (action) {
            case "summary": {
                const summary = quota.getQuotaSummary();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...summary }, null, 2) }] };
            }
            case "check_vm": {
                const result = quota.checkVMCreation(cpu_cores, ram_gb, storage_gb, platform);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...result }, null, 2) }] };
            }
            case "check_run": {
                const result = quota.checkConcurrentRun();
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...result }, null, 2) }] };
            }
            case "set_tier": {
                if (!tier) return { content: [{ type: "text", text: "tier is required." }], isError: true };
                quota.setTier(tier as any);
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: `Tier set to '${tier}'`, quota: quota.getQuota() }, null, 2) }] };
            }
            case "usage": {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ok", usage: quota.getUsage() }, null, 2) }] };
            }
            default:
                return { content: [{ type: "text", text: `Unknown quota action: ${action}` }], isError: true };
        }
    } catch (err) {
        debugLog(`vm_quota error: ${err}`);
        return { content: [{ type: "text", text: `VM quota error: ${err}` }], isError: true };
    }
}
