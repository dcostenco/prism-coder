import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredHostProfiles, parseExecutionAssignments, EXECUTION_ROLES_KEY } from "../../src/utils/executionRoles.js";
import { closeConfigStorage, setSetting } from "../../src/storage/configStorage.js";
import { LOCAL_CODING_SETTING_KEY } from "../../src/utils/localCodingSettings.js";
import { localCodingPreference } from "../../src/utils/localCodingPreference.js";
afterEach(() => { closeConfigStorage(); vi.unstubAllEnvs(); });

describe("execution role contract", () => {
    it("separates exact execution roles from memory roles and strict v2 settings", () => {
        expect(parseExecutionAssignments({ coder: { runtime: "ollama", model: "vendor/future:tag" }, reviewer: { runtime: "synalux" } }))
            .toEqual({ coder: { runtime: "ollama", model: "vendor/future:tag" }, reviewer: { runtime: "synalux" } });
        for (const bad of [{ dev: { runtime: "auto" } }, { coder: { runtime: "synalux", model: "pretend-exact" } },
            { reviewer: { runtime: "omlx", model: "model", effort: "high" } }, { coder: { runtime: "host", profile: "/secret/path" } }])
            expect(() => parseExecutionAssignments(bad)).toThrow("execution_assignment_invalid");
    });
    it("exposes sanitized configured identities, never aliases, paths or credentials", async () => {
        const dir = await mkdtemp(join(tmpdir(), "host-profiles-")), path = join(dir, "reviewers.json");
        await writeFile(path, JSON.stringify({ version: 1, reviewers: { privateAlias: { kind: "host", provider: "claude", model: "example-model", reasoning_effort: "high", api_key: "fixture", runtime_module: "/private/path" },
            rejected: { kind: "host", provider: "claude", model: "sk-private-secret" },
            path: { kind: "host", provider: "claude", model: "C:/internal/runtime" },
            uri: { kind: "host", provider: "claude", model: "file:///private/runtime" },
            local: { kind: "prism", model: "local-model" } } }), { mode: 0o600 });
        const profiles = await configuredHostProfiles(path);
        expect(profiles).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{64}$/), provider: "claude", model: "example-model", effort: "high", status: "configured" }]);
        expect(JSON.stringify(profiles)).not.toMatch(/privateAlias|private-secret|private\/path|api_key/);
        await chmod(path, 0o666);
        await expect(configuredHostProfiles(path)).rejects.toThrow("host_profiles_unavailable");
        await chmod(path, 0o600); const link = join(dir, "link.json"); await symlink(path, link);
        await expect(configuredHostProfiles(link)).rejects.toThrow("host_profiles_unavailable");
    });
    it("refuses environment retargeting of an exact saved role while explicit calls win", async () => {
        closeConfigStorage(); vi.stubEnv("PRISM_CONFIG_PATH", join(await mkdtemp(join(tmpdir(), "execution-role-config-")), "config.db"));
        await setSetting(LOCAL_CODING_SETTING_KEY, JSON.stringify({backend:"ollama",source:"existing",models:{ollama:{reviewer:"exact:tag"}}}));
        await setSetting(EXECUTION_ROLES_KEY, JSON.stringify({reviewer:{runtime:"ollama",model:"exact:tag"}}));
        vi.stubEnv("PRISM_LOCAL_CODING_BACKEND", "omlx");
        await expect(localCodingPreference("reviewer")).rejects.toThrow("execution_assignment_override_conflict");
        expect(await localCodingPreference("reviewer", "ollama", true, "caller:tag")).toMatchObject({effective:"ollama",assignment:undefined});
        await setSetting(EXECUTION_ROLES_KEY, "{}");
        await expect(localCodingPreference("reviewer")).rejects.toThrow("execution_assignment_override_conflict");
    });
    it("keeps valid host model names containing incidental credential words", async () => {
        const dir=await mkdtemp(join(tmpdir(),"host-profile-names-")), path=join(dir,"reviewers.json");
        await writeFile(path,JSON.stringify({version:1,reviewers:{
            task:{kind:"host",provider:"claude",model:"task-reviewer"},
            tokens:{kind:"host",provider:"claude",model:"tokenizer-model"},
            secretName:{kind:"host",provider:"claude",model:"vendor/secret-model"},
            credential:{kind:"host",provider:"claude",model:"sk-private-secret"},
        }}),{mode:0o600});
        expect((await configuredHostProfiles(path)).map(p=>p.model)).toEqual(["task-reviewer","tokenizer-model","vendor/secret-model"]);
    });
});
