/**
 * v12.2: Real-Time Notifications — Webhook / Slack / Email
 *
 * Sends alerts when significant memory events occur:
 * - Health degradation (missing embeddings, orphaned entries)
 * - Compaction completed (with summary stats)
 * - Backup completed or failed
 * - Memory threshold exceeded (per-project entry count)
 *
 * Configuration via Mind Palace Dashboard or environment variables.
 * Zero external dependencies — uses native fetch API.
 */

import { debugLog } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────

export type NotificationChannel = "webhook" | "slack" | "email";
export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationEvent =
    | "health_degradation"
    | "compaction_complete"
    | "backup_complete"
    | "backup_failed"
    | "memory_threshold"
    | "new_graduated_insight"
    | "scheduler_error";

export interface NotificationConfig {
    enabled: boolean;
    channels: ChannelConfig[];
    minSeverity: NotificationSeverity;
    cooldownMs: number; // Prevent notification storms
}

export interface ChannelConfig {
    type: NotificationChannel;
    url: string; // Webhook URL, Slack webhook, or email endpoint
    events: NotificationEvent[]; // Which events trigger this channel
    enabled: boolean;
}

export interface NotificationPayload {
    event: NotificationEvent;
    severity: NotificationSeverity;
    title: string;
    message: string;
    project?: string;
    details?: Record<string, unknown>;
    timestamp: string;
}

// ─── Default Config ──────────────────────────────────────────

const DEFAULT_CONFIG: NotificationConfig = {
    enabled: false,
    channels: [],
    minSeverity: "warning",
    cooldownMs: 300_000, // 5 minutes between same-event notifications
};

let currentConfig: NotificationConfig = { ...DEFAULT_CONFIG };

// ─── Cooldown Tracking ───────────────────────────────────────

const lastNotifiedAt = new Map<string, number>();

function isInCooldown(event: NotificationEvent, project?: string): boolean {
    const key = `${event}:${project || "global"}`;
    const last = lastNotifiedAt.get(key);
    if (!last) return false;
    return Date.now() - last < currentConfig.cooldownMs;
}

function markNotified(event: NotificationEvent, project?: string): void {
    const key = `${event}:${project || "global"}`;
    lastNotifiedAt.set(key, Date.now());
}

// ─── Severity Check ──────────────────────────────────────────

const SEVERITY_ORDER: NotificationSeverity[] = ["info", "warning", "critical"];

function meetsMinSeverity(severity: NotificationSeverity): boolean {
    return (
        SEVERITY_ORDER.indexOf(severity) >=
        SEVERITY_ORDER.indexOf(currentConfig.minSeverity)
    );
}

// ─── Channel Senders ─────────────────────────────────────────

async function sendWebhook(
    url: string,
    payload: NotificationPayload,
): Promise<boolean> {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
    } catch (err) {
        debugLog(`Webhook notification failed: ${err}`);
        return false;
    }
}

async function sendSlack(
    webhookUrl: string,
    payload: NotificationPayload,
): Promise<boolean> {
    const severityEmoji: Record<NotificationSeverity, string> = {
        info: "ℹ️",
        warning: "⚠️",
        critical: "🚨",
    };

    const slackPayload = {
        text: `${severityEmoji[payload.severity]} *${payload.title}*`,
        blocks: [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: `${severityEmoji[payload.severity]} ${payload.title}`,
                },
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: payload.message,
                },
            },
            ...(payload.project
                ? [
                    {
                        type: "context",
                        elements: [
                            {
                                type: "mrkdwn",
                                text: `*Project:* ${payload.project} | *Time:* ${payload.timestamp}`,
                            },
                        ],
                    },
                ]
                : []),
        ],
    };

    try {
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(slackPayload),
            signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
    } catch (err) {
        debugLog(`Slack notification failed: ${err}`);
        return false;
    }
}

async function sendEmail(
    endpoint: string,
    payload: NotificationPayload,
): Promise<boolean> {
    // Email via webhook relay (e.g., SendGrid, Mailgun, or custom endpoint)
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subject: `[Prism ${payload.severity.toUpperCase()}] ${payload.title}`,
                body: payload.message,
                project: payload.project,
                details: payload.details,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
    } catch (err) {
        debugLog(`Email notification failed: ${err}`);
        return false;
    }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Configure notification channels.
 */
export function configureNotifications(config: Partial<NotificationConfig>): void {
    currentConfig = { ...currentConfig, ...config };
    debugLog(
        `Notifications configured: ${currentConfig.channels.length} channels, enabled=${currentConfig.enabled}`
    );
}

/**
 * Get current notification configuration.
 */
export function getNotificationConfig(): NotificationConfig {
    return { ...currentConfig };
}

/**
 * Send a notification across all configured channels.
 *
 * Respects:
 * - enabled flag
 * - minimum severity
 * - per-event cooldown
 * - channel event filters
 */
export async function notify(
    event: NotificationEvent,
    severity: NotificationSeverity,
    title: string,
    message: string,
    project?: string,
    details?: Record<string, unknown>,
): Promise<{ sent: number; failed: number }> {
    if (!currentConfig.enabled) return { sent: 0, failed: 0 };
    if (!meetsMinSeverity(severity)) return { sent: 0, failed: 0 };
    if (isInCooldown(event, project)) {
        debugLog(`Notification cooldown active for ${event}:${project || "global"}`);
        return { sent: 0, failed: 0 };
    }

    const payload: NotificationPayload = {
        event,
        severity,
        title,
        message,
        project,
        details,
        timestamp: new Date().toISOString(),
    };

    let sent = 0;
    let failed = 0;

    for (const channel of currentConfig.channels) {
        if (!channel.enabled) continue;
        if (channel.events.length > 0 && !channel.events.includes(event)) continue;

        let success = false;
        switch (channel.type) {
            case "webhook":
                success = await sendWebhook(channel.url, payload);
                break;
            case "slack":
                success = await sendSlack(channel.url, payload);
                break;
            case "email":
                success = await sendEmail(channel.url, payload);
                break;
        }

        if (success) {
            sent++;
        } else {
            failed++;
        }
    }

    if (sent > 0) {
        markNotified(event, project);
    }

    debugLog(`Notification: ${event} → ${sent} sent, ${failed} failed`);
    return { sent, failed };
}

/**
 * Load notification config from environment variables.
 */
export function loadNotificationConfigFromEnv(): void {
    const webhookUrl = process.env.PRISM_NOTIFICATION_WEBHOOK;
    const slackUrl = process.env.PRISM_NOTIFICATION_SLACK;

    if (!webhookUrl && !slackUrl) return;

    const channels: ChannelConfig[] = [];

    if (webhookUrl) {
        channels.push({
            type: "webhook",
            url: webhookUrl,
            events: [],
            enabled: true,
        });
    }

    if (slackUrl) {
        channels.push({
            type: "slack",
            url: slackUrl,
            events: [],
            enabled: true,
        });
    }

    configureNotifications({
        enabled: true,
        channels,
        minSeverity: (process.env.PRISM_NOTIFICATION_MIN_SEVERITY as NotificationSeverity) || "warning",
    });
}

debugLog("v12.2: Notification module loaded");
