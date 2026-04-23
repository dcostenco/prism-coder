/**
 * Prism Projects — MCP Tool Handlers (Phase 4)
 * ===============================================
 *
 * CRUD operations for projects and team membership.
 * Tier limits enforced via getCloudLimits().
 *
 * Tools:
 *   - project_create: Create a new project
 *   - project_list: List all projects for current user
 *   - project_update: Update project name/description/status
 *   - project_delete: Archive/delete a project
 *   - project_assign_member: Add a member to a project
 *   - project_remove_member: Remove a member from a project
 */

import { randomUUID } from 'crypto';
import { getStorage } from '../storage/index.js';
import { getCloudLimits } from '../prism-cloud.js';
import { PRISM_USER_ID } from '../config.js';

const VALID_STATUSES = ['draft', 'active', 'on_hold', 'completed', 'archived'] as const;
const VALID_ROLES = ['owner', 'editor', 'viewer'] as const;

// Tier limits for projects
const PROJECT_LIMITS: Record<string, { maxProjects: number; maxMembers: number }> = {
    free: { maxProjects: 1, maxMembers: 1 },
    standard: { maxProjects: 9, maxMembers: 5 },
    advanced: { maxProjects: 999, maxMembers: 25 },
    enterprise: { maxProjects: 999999, maxMembers: 999999 },
};

function makeResult(text: string, isError = false) {
    return { content: [{ type: 'text' as const, text }], isError };
}

// ─── project_create ──────────────────────────────────────────

export async function projectCreateHandler(args: {
    name: string;
    description?: string;
    status?: string;
    team_id?: string;
}) {
    const { name, description, status, team_id } = args;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return makeResult('❌ Missing required field: name', true);
    }

    if (status && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
        return makeResult(`❌ Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, true);
    }

    // Check tier limits
    const limits = getCloudLimits();
    const tierLimits = PROJECT_LIMITS[limits.tier] || PROJECT_LIMITS.free;

    const storage = await getStorage();
    const db = (storage as any).db;
    if (!db) {
        return makeResult('❌ Project management requires SQLite storage.', true);
    }

    // Count existing projects
    const countResult = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM prism_projects WHERE created_by = ?',
        args: [PRISM_USER_ID],
    });
    const currentCount = Number(countResult.rows[0]?.cnt || 0);

    if (currentCount >= tierLimits.maxProjects) {
        return makeResult(
            `❌ Project limit reached (${currentCount}/${tierLimits.maxProjects}). ` +
            `Upgrade your plan to create more projects.`,
            true
        );
    }

    const id = randomUUID();
    await db.execute({
        sql: `INSERT INTO prism_projects (id, name, description, status, created_by, team_id)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [id, name.trim(), description || '', status || 'draft', PRISM_USER_ID, team_id || null],
    });

    // Auto-assign creator as owner
    await db.execute({
        sql: `INSERT INTO prism_project_members (project_id, user_id, role)
              VALUES (?, ?, 'owner')`,
        args: [id, PRISM_USER_ID],
    });

    return makeResult(
        `✅ Project created: "${name.trim()}" (${id})\n` +
        `   Status: ${status || 'draft'}\n` +
        `   Projects used: ${currentCount + 1}/${tierLimits.maxProjects}`
    );
}

// ─── project_list ────────────────────────────────────────────

export async function projectListHandler(args: {
    status?: string;
    team_id?: string;
}) {
    const storage = await getStorage();
    const db = (storage as any).db;
    if (!db) {
        return makeResult('❌ Project management requires SQLite storage.', true);
    }

    let sql = `SELECT p.*, m.role as my_role
               FROM prism_projects p
               LEFT JOIN prism_project_members m ON p.id = m.project_id AND m.user_id = ?
               WHERE (p.created_by = ? OR m.user_id = ?)`;
    const sqlArgs: Array<string | null> = [PRISM_USER_ID, PRISM_USER_ID, PRISM_USER_ID];

    if (args.status) {
        sql += ` AND p.status = ?`;
        sqlArgs.push(args.status);
    }
    if (args.team_id) {
        sql += ` AND p.team_id = ?`;
        sqlArgs.push(args.team_id);
    }

    sql += ` ORDER BY p.updated_at DESC`;

    const result = await db.execute({ sql, args: sqlArgs });
    const projects = result.rows;

    if (projects.length === 0) {
        return makeResult('📁 No projects found. Use `project_create` to create one.');
    }

    const lines = projects.map((p: any) => {
        const statusIcon = p.status === 'active' ? '🟢' : p.status === 'draft' ? '📝' : p.status === 'completed' ? '✅' : p.status === 'archived' ? '📦' : '⏸️';
        return `${statusIcon} **${p.name}** (${p.id.substring(0, 8)})\n   Status: ${p.status} | Role: ${p.my_role || 'owner'} | Updated: ${p.updated_at}`;
    });

    const limits = getCloudLimits();
    const tierLimits = PROJECT_LIMITS[limits.tier] || PROJECT_LIMITS.free;

    return makeResult(
        `📁 **Projects** (${projects.length}/${tierLimits.maxProjects})\n\n` +
        lines.join('\n\n')
    );
}

// ─── project_update ──────────────────────────────────────────

export async function projectUpdateHandler(args: {
    project_id: string;
    name?: string;
    description?: string;
    status?: string;
}) {
    const { project_id, name, description, status } = args;

    if (!project_id) {
        return makeResult('❌ Missing required field: project_id', true);
    }

    if (status && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
        return makeResult(`❌ Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, true);
    }

    const storage = await getStorage();
    const db = (storage as any).db;
    if (!db) return makeResult('❌ Project management requires SQLite storage.', true);

    const sets: string[] = ["updated_at = datetime('now')"];
    const sqlArgs: Array<string> = [];

    if (name) { sets.push('name = ?'); sqlArgs.push(name.trim()); }
    if (description !== undefined) { sets.push('description = ?'); sqlArgs.push(description); }
    if (status) { sets.push('status = ?'); sqlArgs.push(status); }

    sqlArgs.push(project_id);

    await db.execute({
        sql: `UPDATE prism_projects SET ${sets.join(', ')} WHERE id = ?`,
        args: sqlArgs,
    });

    return makeResult(`✅ Project ${project_id.substring(0, 8)} updated.`);
}

// ─── project_delete ──────────────────────────────────────────

export async function projectDeleteHandler(args: { project_id: string; hard?: boolean }) {
    const { project_id, hard } = args;

    if (!project_id) {
        return makeResult('❌ Missing required field: project_id', true);
    }

    const storage = await getStorage();
    const db = (storage as any).db;
    if (!db) return makeResult('❌ Project management requires SQLite storage.', true);

    if (hard) {
        await db.execute({ sql: 'DELETE FROM prism_projects WHERE id = ?', args: [project_id] });
        return makeResult(`🗑️ Project ${project_id.substring(0, 8)} permanently deleted.`);
    } else {
        await db.execute({
            sql: `UPDATE prism_projects SET status = 'archived', updated_at = datetime('now') WHERE id = ?`,
            args: [project_id],
        });
        return makeResult(`📦 Project ${project_id.substring(0, 8)} archived.`);
    }
}

// ─── project_assign_member ───────────────────────────────────

export async function projectAssignMemberHandler(args: {
    project_id: string;
    user_id: string;
    role?: string;
}) {
    const { project_id, user_id, role } = args;

    if (!project_id || !user_id) {
        return makeResult('❌ Missing required fields: project_id, user_id', true);
    }

    const effectiveRole = role || 'viewer';
    if (!VALID_ROLES.includes(effectiveRole as typeof VALID_ROLES[number])) {
        return makeResult(`❌ Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`, true);
    }

    // Check tier limits
    const limits = getCloudLimits();
    const tierLimits = PROJECT_LIMITS[limits.tier] || PROJECT_LIMITS.free;

    const storage = await getStorage();
    const db = (storage as any).db;
    if (!db) return makeResult('❌ Project management requires SQLite storage.', true);

    const countResult = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM prism_project_members WHERE project_id = ?',
        args: [project_id],
    });
    const currentMembers = Number(countResult.rows[0]?.cnt || 0);

    if (currentMembers >= tierLimits.maxMembers) {
        return makeResult(
            `❌ Member limit reached (${currentMembers}/${tierLimits.maxMembers}). ` +
            `Upgrade your plan to add more members.`,
            true
        );
    }

    await db.execute({
        sql: `INSERT OR REPLACE INTO prism_project_members (project_id, user_id, role)
              VALUES (?, ?, ?)`,
        args: [project_id, user_id, effectiveRole],
    });

    return makeResult(`✅ ${user_id} assigned as ${effectiveRole} to project ${project_id.substring(0, 8)}.`);
}

// ─── project_remove_member ───────────────────────────────────

export async function projectRemoveMemberHandler(args: {
    project_id: string;
    user_id: string;
}) {
    const { project_id, user_id } = args;

    if (!project_id || !user_id) {
        return makeResult('❌ Missing required fields: project_id, user_id', true);
    }

    const storage = await getStorage();
    const db = (storage as any).db;
    if (!db) return makeResult('❌ Project management requires SQLite storage.', true);

    await db.execute({
        sql: 'DELETE FROM prism_project_members WHERE project_id = ? AND user_id = ?',
        args: [project_id, user_id],
    });

    return makeResult(`✅ ${user_id} removed from project ${project_id.substring(0, 8)}.`);
}
