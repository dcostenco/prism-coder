import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/fixtures.js";
const remote = vi.hoisted(() => ({ get: vi.fn(), rpc: vi.fn(), post: vi.fn() }));
vi.mock("../../src/utils/supabaseApi.js", () => ({ supabaseGet: remote.get, supabasePost: remote.post, supabasePatch: vi.fn(), supabaseDelete: vi.fn(), supabaseRpc: remote.rpc }));
import { SupabaseStorage } from "../../src/storage/supabase.js";

describe("exact memory-role merge base", () => {
    let testDb: Awaited<ReturnType<typeof createTestDb>>;
    beforeAll(async () => { testDb=await createTestDb("handoff-role-base"); });
    beforeEach(() => { remote.get.mockReset(); remote.rpc.mockReset(); remote.post.mockReset(); });
    afterAll(() => testDb?.cleanup());
    it("SQLite does not select another role with the same project and version", async () => {
        const base={project:"roles",user_id:"owner",version:4,last_summary:"private"};
        for (const role of ["dev", "qa"]) {
            for (let version = 1; version <= 4; version++) {
                await testDb.storage.saveHandoff({ ...base, role, pending_todo:[`${role} task`] });
            }
        }
        await testDb.storage.saveHistorySnapshot({...base,role:"dev",last_summary:"Untrusted caller summary",pending_todo:[]},"dev");
        await testDb.storage.saveHistorySnapshot({...base,role:"qa",pending_todo:["qa task"]},"qa");
        expect(await testDb.storage.getHandoffAtVersion("roles",4,"owner","dev")).toMatchObject({role:"dev",last_summary:"private",pending_todo:["dev task"]});
        expect(await testDb.storage.getHandoffAtVersion("roles",4,"owner","qa")).toMatchObject({role:"qa",pending_todo:["qa task"]});
        expect(await testDb.storage.getHandoffAtVersion("roles",4,"other","dev")).toBeNull();
    });
    it("SQLite refuses a snapshot when the requested version is no longer current", async () => {
        const identity={project:"canonical-sqlite",user_id:"owner",role:"dev",last_summary:"First"};
        await testDb.storage.saveHandoff(identity);
        await testDb.storage.saveHandoff({...identity,last_summary:"Second"},1);
        await expect(testDb.storage.saveHistorySnapshot({...identity,version:1})).rejects.toThrow(/could not be verified/);
        expect(await testDb.storage.getHandoffAtVersion(identity.project,1,"owner","dev")).toBeNull();
    });
    it("direct Supabase requests canonical history without forwarding caller state", async () => {
        remote.rpc.mockResolvedValue({project:"roles",user_id:"owner",workspace_id:null,role:"dev",version:4,last_summary:"Committed state"});
        await new SupabaseStorage().saveHistorySnapshot({project:"roles",user_id:"owner",role:"dev",version:4,last_summary:"Untrusted caller state"});
        expect(remote.rpc).toHaveBeenCalledWith("save_prism_handoff_history",{p_project:"roles",p_user_id:"owner",
            p_workspace_id:null,p_role:"dev",p_version:4,p_branch:"main"});
        expect(remote.post).not.toHaveBeenCalled();
    });
    it("direct Supabase base queries stay in the legacy principal and exact role", async () => {
        remote.get.mockResolvedValue([{snapshot:{project:"roles",role:"dev",version:4}}]);
        expect(await new SupabaseStorage().getHandoffAtVersion("roles",4,"owner","dev")).toMatchObject({role:"dev"});
        expect(remote.get).toHaveBeenCalledWith("session_handoffs_history",expect.objectContaining({project:"eq.roles",user_id:"eq.owner",version:"eq.4","snapshot->>role":"eq.dev",workspace_id:"is.null"}));
    });
    it("uses the snapshot workspace only after a proven legacy-column error", async () => {
        const missingColumn = Object.assign(new Error("legacy schema"), {
            status: 400, code: "42703",
            body: '{"code":"42703","message":"column session_handoffs_history.workspace_id does not exist"}',
        });
        remote.get.mockRejectedValueOnce(missingColumn).mockResolvedValueOnce([{snapshot:{project:"roles",version:4}}]);
        expect(await new SupabaseStorage().getHandoffAtVersion("roles",4,"owner","global")).toMatchObject({project:"roles"});
        expect(remote.get).toHaveBeenNthCalledWith(1,"session_handoffs_history",expect.objectContaining({
            project:"eq.roles",user_id:"eq.owner",version:"eq.4",workspace_id:"is.null",
            or:"(snapshot->>role.eq.global,snapshot->>role.is.null)",
        }));
        expect(remote.get).toHaveBeenNthCalledWith(2,"session_handoffs_history",expect.objectContaining({
            project:"eq.roles",user_id:"eq.owner",version:"eq.4","snapshot->>workspace_id":"is.null",
            or:"(snapshot->>role.eq.global,snapshot->>role.is.null)",
        }));
        expect(remote.get.mock.calls[1]?.[1]).not.toHaveProperty("workspace_id");
    });
    it("does not treat a generic PostgREST failure as a legacy schema", async () => {
        remote.get.mockRejectedValue(Object.assign(new Error("service unavailable"), {
            status: 503, code: "PGRST002", body: '{"code":"PGRST002"}',
        }));
        await expect(new SupabaseStorage().getHandoffAtVersion("roles",4,"owner","global")).rejects.toThrow("service unavailable");
        expect(remote.get).toHaveBeenCalledTimes(1);
    });
    it("a failed direct history read never becomes an empty merge base", async () => {
        remote.get.mockRejectedValue(new Error("synthetic history outage"));
        await expect(new SupabaseStorage().getHandoffAtVersion("roles",4,"owner","dev")).rejects.toThrow("history outage");
    });
});
