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
    it("uses the explicit restore RPC only for a role-exact versioned history restore", async () => {
        remote.rpc.mockResolvedValue({status:"updated",version:3,history_saved:true});
        const handoff={project:"restore",user_id:"owner",role:"dev",key_context:null,active_branch:null};
        await new SupabaseStorage().saveHandoff(handoff,2,{restoreContextFields:true});
        expect(remote.rpc).toHaveBeenCalledWith("restore_handoff_with_version",expect.objectContaining({
            p_project:"restore",p_user_id:"owner",p_role:"dev",p_expected_version:2,p_key_context:null,p_active_branch:null,
        }));
        remote.rpc.mockClear();
        await new SupabaseStorage().saveHandoff(handoff,2);
        expect(remote.rpc).toHaveBeenCalledWith("save_handoff_with_version",expect.anything());
    });
    it.each([undefined,null,0,-1,1.5])("refuses restore without a positive integer current version: %s",async expected=>{
        await expect(new SupabaseStorage().saveHandoff({project:"restore",user_id:"owner"},expected,{restoreContextFields:true}))
            .rejects.toThrow("positive current version");
        expect(remote.rpc).not.toHaveBeenCalled();
    });
    it("does not downgrade an unavailable restore RPC to an ordinary save",async()=>{
        remote.rpc.mockRejectedValue(new Error("restore RPC unavailable"));
        await expect(new SupabaseStorage().saveHandoff({project:"restore",user_id:"owner",role:"dev"},2,{restoreContextFields:true}))
            .rejects.toThrow("restore RPC unavailable");
        expect(remote.rpc).toHaveBeenCalledTimes(1);
        expect(remote.rpc.mock.calls[0][0]).toBe("restore_handoff_with_version");
    });
    it.each([null,{}, {status:"created",version:3,history_saved:true},{status:"updated",version:3},{status:"updated",version:4,history_saved:true}])(
        "does not certify malformed or non-atomic restore completion: %j",async result=>{
            remote.rpc.mockResolvedValue(result);
            await expect(new SupabaseStorage().saveHandoff({project:"restore",user_id:"owner",role:"global"},2,{restoreContextFields:true}))
                .rejects.toThrow("restoration was not confirmed");
        });
    it("rejects malformed historical context before a direct restore request",async()=>{
        await expect(new SupabaseStorage().saveHandoff({project:"restore",user_id:"owner",role:"dev",key_context:42 as any},2,{restoreContextFields:true}))
            .rejects.toThrow("text or null");
        expect(remote.rpc).not.toHaveBeenCalled();
    });
    it.each([undefined,"","   "])("never substitutes global for an unproven restore role: %s",async role=>{
        await expect(new SupabaseStorage().saveHandoff({project:"restore",user_id:"owner",role},2,{restoreContextFields:true}))
            .rejects.toThrow("explicit memory role");
        expect(remote.rpc).not.toHaveBeenCalled();
    });
    it("SQLite restores null context in the same exact role without touching another role",async()=>{
        const identity={project:"local-restore",user_id:"owner",role:"dev"};
        await testDb.storage.saveHandoff({...identity,last_summary:"New",key_context:"New context",active_branch:"feature/new"});
        await testDb.storage.saveHandoff({...identity,role:"qa",key_context:"QA context",active_branch:"qa"});
        await testDb.storage.saveHistorySnapshot({...identity,role:"qa",version:1});
        await testDb.storage.saveHandoff({...identity,last_summary:"Restored",key_context:null,active_branch:null},1,{restoreContextFields:true});
        await testDb.storage.saveHistorySnapshot({...identity,version:2});
        expect(await testDb.storage.getHandoffAtVersion(identity.project,2,identity.user_id,"dev"))
            .toMatchObject({key_context:null,active_branch:null,version:2});
        expect(await testDb.storage.getHandoffAtVersion(identity.project,1,identity.user_id,"qa"))
            .toMatchObject({key_context:"QA context",active_branch:"qa",version:1});
    });
    it("SQLite never recreates a missing current partition during explicit restoration",async()=>{
        const identity={project:"vanished-restore",user_id:"owner",role:"dev"};
        expect(await testDb.storage.saveHandoff({...identity,key_context:null,active_branch:null},2,{restoreContextFields:true}))
            .toEqual({status:"conflict",current_version:0});
        expect(await testDb.storage.loadContext(identity.project,"quick",identity.user_id,identity.role)).toBeNull();
        // Ordinary versioned saves retain their existing first-create behavior.
        expect(await testDb.storage.saveHandoff({...identity,last_summary:"Ordinary save"},2))
            .toMatchObject({status:"created",version:1});
    });
});
