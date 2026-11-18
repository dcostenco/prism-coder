export type ShimActionTarget = "daemon" | "client";

export interface ShimAction {
  to: ShimActionTarget;
  line: string;
}

export interface ShimSessionOptions {
  clientId: string;
  cwd?: string;
  mutatingTools: readonly string[];
  requestTimeoutMs: number;
  configFingerprint?: string;
}

interface InFlightEntry {
  line: string;
  sentOnGeneration: number | null;
  deathsWhileServing: number;
}

interface PendingSubscriptionOp {
  type: "subscribe" | "unsubscribe";
  uri: string;
}

const REINIT_ID_PREFIX = "prism-shim-reinit-";
const REPLAY_ID_PREFIX = "prism-shim-replay-";
const CONFIG_MISMATCH_MESSAGE =
  "prism daemon is running with a different PRISM_USER_ID / PRISM_STORAGE / SUPABASE_URL / PRISM_HDC_ENABLED / PRISM_ENABLE_HIVEMIND; run `node dist/daemon.js restart` or align the environment";
const CRASH_LOOP_MESSAGE = "request was in flight during repeated prism daemon crashes; not retried";

function tryParseJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export class ShimSession {
  private readonly clientId: string;
  private readonly cwd: string | undefined;
  private readonly mutatingTools: Set<string>;
  private readonly requestTimeoutMs: number;
  private readonly configFingerprint?: string;

  private connected = false;
  private connectionGeneration = 0;
  private connectionServing = false;
  private disconnectedAt: number | null = null;
  private initializeRequestRaw: string | null = null;
  private initializedSeen = false;
  private reinitCounter = 0;
  private replaySeq = 0;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private queue: string[] = [];
  private readonly pendingSubscriptionOps = new Map<string, PendingSubscriptionOp>();
  private readonly subscribedResources = new Set<string>();
  private lastLogLevel: string | null = null;
  private fatalError: { code: number; message: string } | null = null;

  constructor(options: ShimSessionOptions) {
    this.clientId = options.clientId;
    this.cwd = options.cwd;
    this.mutatingTools = new Set(options.mutatingTools);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.configFingerprint = options.configFingerprint;
  }

  isFatal(): boolean {
    return this.fatalError !== null;
  }

  onClientLine(rawLine: string, nowMs: number): ShimAction[] {
    const parsed = tryParseJson(rawLine);

    if (this.fatalError) {
      return this.replyFatalIfRequest(parsed);
    }

    if (parsed === undefined || parsed === null || typeof parsed !== "object") {
      return this.forwardOrQueue(rawLine);
    }

    const hasId = Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id !== undefined;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const isRequest = hasId && method !== undefined;

    if (isRequest && method === "initialize") {
      this.initializeRequestRaw = rawLine;
    }

    if (!hasId && method === "notifications/initialized") {
      const alreadySeen = this.initializedSeen;
      this.initializedSeen = true;
      if (!this.connected && alreadySeen) {
        return [];
      }
      return this.forwardOrQueue(rawLine);
    }

    if (!hasId && method === "notifications/cancelled") {
      const requestId = parsed.params?.requestId;
      if (requestId !== undefined) {
        this.inFlight.delete(JSON.stringify(requestId));
      }
      return this.forwardOrQueue(rawLine);
    }

    if (isRequest) {
      let line = rawLine;
      if (method === "tools/call" && parsed.params && this.mutatingTools.has(parsed.params.name)) {
        const meta = { ...(parsed.params._meta || {}), "prism/idempotencyKey": `${this.clientId}:${JSON.stringify(parsed.id)}` };
        const withMeta = { ...parsed, params: { ...parsed.params, _meta: meta } };
        line = JSON.stringify(withMeta);
      }

      const key = JSON.stringify(parsed.id);

      if (method === "resources/subscribe" && typeof parsed.params?.uri === "string") {
        this.pendingSubscriptionOps.set(key, { type: "subscribe", uri: parsed.params.uri });
      } else if (method === "resources/unsubscribe" && typeof parsed.params?.uri === "string") {
        this.pendingSubscriptionOps.set(key, { type: "unsubscribe", uri: parsed.params.uri });
      } else if (method === "logging/setLevel" && typeof parsed.params?.level === "string") {
        this.lastLogLevel = parsed.params.level;
      }

      if (this.connected) {
        this.inFlight.set(key, { line, sentOnGeneration: this.connectionGeneration, deathsWhileServing: 0 });
        return [{ to: "daemon", line }];
      }
      this.inFlight.set(key, { line, sentOnGeneration: null, deathsWhileServing: 0 });
      return [];
    }

    if (hasId) {
      if (this.connected) {
        return [{ to: "daemon", line: rawLine }];
      }
      return [];
    }

    return this.forwardOrQueue(rawLine);
  }

  private replyFatalIfRequest(parsed: any): ShimAction[] {
    if (!this.fatalError) return [];
    if (parsed === undefined || parsed === null || typeof parsed !== "object") return [];

    const hasId = Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id !== undefined;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    if (!hasId || method === undefined) return [];

    return [{
      to: "client",
      line: JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: this.fatalError.code, message: this.fatalError.message },
      }),
    }];
  }

  private forwardOrQueue(rawLine: string): ShimAction[] {
    if (this.connected) {
      return [{ to: "daemon", line: rawLine }];
    }
    this.queue.push(rawLine);
    return [];
  }

  onDaemonLine(rawLine: string): ShimAction[] {
    const parsed = tryParseJson(rawLine);
    if (parsed === undefined || parsed === null || typeof parsed !== "object") {
      return [{ to: "client", line: rawLine }];
    }

    if (parsed.prism_hello_error) {
      return this.enterFatalMode(CONFIG_MISMATCH_MESSAGE);
    }

    const hasId = Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id !== undefined;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const isServerRequest = hasId && method !== undefined;

    if (hasId && !isServerRequest) {
      this.connectionServing = true;
      const key = JSON.stringify(parsed.id);

      const subscriptionOp = this.pendingSubscriptionOps.get(key);
      if (subscriptionOp) {
        this.pendingSubscriptionOps.delete(key);
        if (!parsed.error) {
          if (subscriptionOp.type === "subscribe") {
            this.subscribedResources.add(subscriptionOp.uri);
          } else {
            this.subscribedResources.delete(subscriptionOp.uri);
          }
        }
      }

      const isSynthetic = typeof parsed.id === "string"
        && (parsed.id.startsWith(REINIT_ID_PREFIX) || parsed.id.startsWith(REPLAY_ID_PREFIX));
      if (isSynthetic) {
        return [];
      }

      this.inFlight.delete(key);
    }

    return [{ to: "client", line: rawLine }];
  }

  onConnected(): ShimAction[] {
    this.connected = true;
    this.disconnectedAt = null;
    this.connectionGeneration += 1;
    this.connectionServing = false;

    const actions: ShimAction[] = [];
    const helloPayload: Record<string, unknown> = { v: 1, cwd: this.cwd, clientId: this.clientId };
    if (this.configFingerprint !== undefined) {
      helloPayload.configFingerprint = this.configFingerprint;
    }
    actions.push({ to: "daemon", line: JSON.stringify({ prism_hello: helloPayload }) });

    if (this.initializedSeen && this.initializeRequestRaw !== null) {
      this.reinitCounter += 1;
      const reinitId = `${REINIT_ID_PREFIX}${this.reinitCounter}`;
      const parsedInit = tryParseJson(this.initializeRequestRaw);
      const reinitLine = parsedInit !== undefined
        ? JSON.stringify({ ...parsedInit, id: reinitId })
        : this.initializeRequestRaw;
      actions.push({ to: "daemon", line: reinitLine });
      actions.push({ to: "daemon", line: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    }

    for (const [key, entry] of this.inFlight) {
      if (entry.deathsWhileServing >= 2) {
        this.inFlight.delete(key);
        const id = JSON.parse(key);
        actions.push({
          to: "client",
          line: JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32002, message: CRASH_LOOP_MESSAGE },
          }),
        });
        continue;
      }
      entry.sentOnGeneration = this.connectionGeneration;
      actions.push({ to: "daemon", line: entry.line });
    }

    for (const uri of this.subscribedResources) {
      this.replaySeq += 1;
      actions.push({
        to: "daemon",
        line: JSON.stringify({
          jsonrpc: "2.0",
          id: `${REPLAY_ID_PREFIX}${this.replaySeq}`,
          method: "resources/subscribe",
          params: { uri },
        }),
      });
    }

    if (this.lastLogLevel !== null) {
      this.replaySeq += 1;
      actions.push({
        to: "daemon",
        line: JSON.stringify({
          jsonrpc: "2.0",
          id: `${REPLAY_ID_PREFIX}${this.replaySeq}`,
          method: "logging/setLevel",
          params: { level: this.lastLogLevel },
        }),
      });
    }

    for (const queuedLine of this.queue) {
      actions.push({ to: "daemon", line: queuedLine });
    }
    this.queue = [];

    return actions;
  }

  onDisconnected(nowMs: number): ShimAction[] {
    if (this.connectionServing) {
      for (const entry of this.inFlight.values()) {
        if (entry.sentOnGeneration === this.connectionGeneration) entry.deathsWhileServing += 1;
      }
    }
    this.connected = false;
    this.connectionServing = false;
    this.disconnectedAt = nowMs;
    return [];
  }

  checkTimeouts(nowMs: number): ShimAction[] {
    if (this.connected || this.disconnectedAt === null) return [];
    if (nowMs - this.disconnectedAt < this.requestTimeoutMs) return [];

    const actions: ShimAction[] = [];
    for (const key of this.inFlight.keys()) {
      const id = JSON.parse(key);
      actions.push({
        to: "client",
        line: JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "prism daemon unavailable" },
        }),
      });
    }
    this.inFlight.clear();
    return actions;
  }

  private enterFatalMode(message: string): ShimAction[] {
    if (this.fatalError) return [];
    this.fatalError = { code: -32001, message };

    const actions: ShimAction[] = [];
    for (const key of this.inFlight.keys()) {
      const id = JSON.parse(key);
      actions.push({
        to: "client",
        line: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message } }),
      });
    }
    this.inFlight.clear();
    this.queue = [];
    return actions;
  }

  failInFlightRequest(id: unknown, code: number, message: string): ShimAction[] {
    const key = JSON.stringify(id);
    if (!this.inFlight.has(key)) return [];
    this.inFlight.delete(key);
    return [{ to: "client", line: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) }];
  }

  failAllPendingWithError(code: number, message: string): ShimAction[] {
    const actions: ShimAction[] = [];
    for (const key of this.inFlight.keys()) {
      const id = JSON.parse(key);
      actions.push({ to: "client", line: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) });
    }
    this.inFlight.clear();
    return actions;
  }
}
