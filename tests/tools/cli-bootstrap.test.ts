import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("commander", () => {
  class Command {
    name(): this { return this; }
    description(): this { return this; }
    version(): this { return this; }
    command(): this { return this; }
    option(): this { return this; }
    requiredOption(): this { return this; }
    action(): this { return this; }
    async parseAsync(): Promise<this> { return this; }
  }
  return { Command };
});

const { mockCloseStorage, mockSessionBootstrapHandler } = vi.hoisted(() => ({
  mockCloseStorage: vi.fn(async () => {}),
  mockSessionBootstrapHandler: vi.fn(),
}));
vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
  closeStorage: mockCloseStorage,
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async (_key: string, fallback = "") => fallback),
}));

vi.mock("../../src/utils/git.js", () => ({
  getCurrentGitState: vi.fn(() => ({ isRepo: false })),
}));

vi.mock("../../src/config.js", () => ({
  PRISM_USER_ID: "test-user",
  SERVER_CONFIG: { name: "prism-test", version: "test" },
}));

vi.mock("../../src/connect.js", () => ({
  configureClaudeNativeStartup: vi.fn(),
  configureCodexNativeStartup: vi.fn(),
  configureGeminiNativeStartup: vi.fn(),
  connectHosts: vi.fn(),
  migrateLegacyClaudeHooks: vi.fn(),
  migrateLegacyClaudeInstructions: vi.fn(),
  migrateLegacyClaudeManagedStartup: vi.fn(),
  migrateLegacyClaudeProjectMcp: vi.fn(),
  normalizeHostName: vi.fn(),
}));

vi.mock("../../src/tools/ledgerHandlers.js", () => ({
  sessionBootstrapHandler: mockSessionBootstrapHandler,
  sessionLoadContextHandler: vi.fn(),
  sessionSaveLedgerHandler: vi.fn(),
  sessionSaveHandoffHandler: vi.fn(),
}));

import { runBootstrapCommand } from "../../src/cli.js";

const CANONICAL_BOOTSTRAP_TEXT = "👋 Welcome back, Dmitri.\n\n> **Prism System Ready**";

describe("prism bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("prints the exact session_bootstrap display without project or depth arguments", async () => {
    mockSessionBootstrapHandler.mockResolvedValue({
      content: [{ type: "text", text: CANONICAL_BOOTSTRAP_TEXT }],
      isError: false,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runBootstrapCommand();

    expect(mockSessionBootstrapHandler).toHaveBeenCalledOnce();
    expect(mockSessionBootstrapHandler).toHaveBeenCalledWith({});
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(CANONICAL_BOOTSTRAP_TEXT);
    expect(process.exitCode).toBeUndefined();
    expect(mockCloseStorage).toHaveBeenCalledOnce();
  });

  it("fails loud when the canonical handler cannot produce a display", async () => {
    mockSessionBootstrapHandler.mockRejectedValue(new Error("storage unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBootstrapCommand();

    expect(error).toHaveBeenCalledWith("Bootstrap failed: storage unavailable");
    expect(process.exitCode).toBe(1);
    expect(mockCloseStorage).toHaveBeenCalledOnce();
  });
});
