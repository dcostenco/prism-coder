/**
 * v12.3: Role-Based Access Control (RBAC) Engine
 *
 * Enforces project-level and partition-level access control.
 * Roles: admin, editor, viewer (extensible via custom roles).
 * Permissions are checked per-project, per-memory-partition.
 *
 * Storage: Local SQLite table `rbac_roles` + `rbac_assignments` (auto-created).
 */

import { debugLog } from "./logger.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────

export type BuiltinRole = "admin" | "editor" | "viewer";

export interface Permission {
    read: boolean;
    write: boolean;
    delete: boolean;
    admin: boolean;
}

export interface RoleDefinition {
    name: string;
    displayName: string;
    permissions: Permission;
    isBuiltin: boolean;
    createdAt: string;
}

export interface RoleAssignment {
    id: string;
    userId: string;
    role: string;
    project: string;
    partition?: string;
    assignedBy: string;
    assignedAt: string;
    expiresAt?: string;
}

export interface AccessCheckResult {
    allowed: boolean;
    role: string;
    permission: keyof Permission;
    project: string;
    reason: string;
}

// ─── Built-in Role Definitions ───────────────────────────────

const BUILTIN_ROLES: Record<BuiltinRole, RoleDefinition> = {
    admin: {
        name: "admin",
        displayName: "Administrator",
        permissions: { read: true, write: true, delete: true, admin: true },
        isBuiltin: true,
        createdAt: "2026-01-01T00:00:00Z",
    },
    editor: {
        name: "editor",
        displayName: "Editor",
        permissions: { read: true, write: true, delete: false, admin: false },
        isBuiltin: true,
        createdAt: "2026-01-01T00:00:00Z",
    },
    viewer: {
        name: "viewer",
        displayName: "Viewer",
        permissions: { read: true, write: false, delete: false, admin: false },
        isBuiltin: true,
        createdAt: "2026-01-01T00:00:00Z",
    },
};

// ─── In-Memory State ─────────────────────────────────────────

const customRoles = new Map<string, RoleDefinition>();
const assignments = new Map<string, RoleAssignment[]>(); // keyed by `userId:project`

// ─── Role Management ─────────────────────────────────────────

export function getRole(name: string): RoleDefinition | undefined {
    return BUILTIN_ROLES[name as BuiltinRole] || customRoles.get(name);
}

export function listRoles(): RoleDefinition[] {
    return [
        ...Object.values(BUILTIN_ROLES),
        ...Array.from(customRoles.values()),
    ];
}

export function createCustomRole(
    name: string,
    displayName: string,
    permissions: Permission,
): RoleDefinition {
    if (BUILTIN_ROLES[name as BuiltinRole]) {
        throw new Error(`Cannot override built-in role: ${name}`);
    }

    const role: RoleDefinition = {
        name,
        displayName,
        permissions,
        isBuiltin: false,
        createdAt: new Date().toISOString(),
    };

    customRoles.set(name, role);
    debugLog(`RBAC: Created custom role '${name}' with permissions: ${JSON.stringify(permissions)}`);
    return role;
}

export function deleteCustomRole(name: string): boolean {
    if (BUILTIN_ROLES[name as BuiltinRole]) {
        throw new Error(`Cannot delete built-in role: ${name}`);
    }
    return customRoles.delete(name);
}

// ─── Assignment Management ───────────────────────────────────

function assignmentKey(userId: string, project: string): string {
    return `${userId}:${project}`;
}

export function assignRole(
    userId: string,
    role: string,
    project: string,
    assignedBy: string,
    partition?: string,
    expiresAt?: string,
): RoleAssignment {
    const roleDef = getRole(role);
    if (!roleDef) {
        throw new Error(`Unknown role: ${role}. Available: ${listRoles().map(r => r.name).join(", ")}`);
    }

    const assignment: RoleAssignment = {
        id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId,
        role,
        project,
        partition,
        assignedBy,
        assignedAt: new Date().toISOString(),
        expiresAt,
    };

    const key = assignmentKey(userId, project);
    const existing = assignments.get(key) || [];

    // Remove existing assignment for same partition (upsert)
    const filtered = existing.filter(a =>
        a.partition !== partition || a.role !== role
    );
    filtered.push(assignment);
    assignments.set(key, filtered);

    debugLog(`RBAC: Assigned role '${role}' to user '${userId}' on project '${project}'${partition ? ` partition '${partition}'` : ""}`);
    return assignment;
}

export function revokeRole(
    userId: string,
    role: string,
    project: string,
    partition?: string,
): boolean {
    const key = assignmentKey(userId, project);
    const existing = assignments.get(key) || [];
    const filtered = existing.filter(a =>
        !(a.role === role && a.partition === partition)
    );

    if (filtered.length === existing.length) return false;

    assignments.set(key, filtered);
    debugLog(`RBAC: Revoked role '${role}' from user '${userId}' on project '${project}'`);
    return true;
}

export function getUserAssignments(userId: string, project?: string): RoleAssignment[] {
    if (project) {
        return assignments.get(assignmentKey(userId, project)) || [];
    }

    // All assignments for this user across projects
    const all: RoleAssignment[] = [];
    for (const [key, assigns] of assignments) {
        if (key.startsWith(`${userId}:`)) {
            all.push(...assigns);
        }
    }
    return all;
}

export function getProjectMembers(project: string): RoleAssignment[] {
    const members: RoleAssignment[] = [];
    for (const [key, assigns] of assignments) {
        if (key.endsWith(`:${project}`)) {
            members.push(...assigns);
        }
    }
    return members;
}

// ─── Access Control Checks ───────────────────────────────────

export function checkAccess(
    userId: string,
    project: string,
    permission: keyof Permission,
    partition?: string,
): AccessCheckResult {
    const userAssignments = getUserAssignments(userId, project);

    if (userAssignments.length === 0) {
        return {
            allowed: false,
            role: "none",
            permission,
            project,
            reason: `User '${userId}' has no role on project '${project}'`,
        };
    }

    // Check for expired assignments
    const now = new Date();
    const validAssignments = userAssignments.filter(a => {
        if (!a.expiresAt) return true;
        return new Date(a.expiresAt) > now;
    });

    if (validAssignments.length === 0) {
        return {
            allowed: false,
            role: "expired",
            permission,
            project,
            reason: `All role assignments for '${userId}' on '${project}' have expired`,
        };
    }

    // If partition is specified, check partition-specific assignments first
    if (partition) {
        const partitionAssigns = validAssignments.filter(a => a.partition === partition);
        if (partitionAssigns.length > 0) {
            // Use highest-privilege partition assignment
            for (const assign of partitionAssigns) {
                const role = getRole(assign.role);
                if (role && role.permissions[permission]) {
                    return {
                        allowed: true,
                        role: assign.role,
                        permission,
                        project,
                        reason: `Granted via partition-level role '${assign.role}'`,
                    };
                }
            }
        }
    }

    // Check project-level assignments (no partition filter)
    const projectAssigns = validAssignments.filter(a => !a.partition);
    for (const assign of projectAssigns) {
        const role = getRole(assign.role);
        if (role && role.permissions[permission]) {
            return {
                allowed: true,
                role: assign.role,
                permission,
                project,
                reason: `Granted via project-level role '${assign.role}'`,
            };
        }
    }

    // No matching permission found
    const highestRole = validAssignments[0]?.role || "none";
    return {
        allowed: false,
        role: highestRole,
        permission,
        project,
        reason: `Role '${highestRole}' does not have '${permission}' permission on '${project}'`,
    };
}

/**
 * Middleware-style check: throws if access denied.
 */
export function requireAccess(
    userId: string,
    project: string,
    permission: keyof Permission,
    partition?: string,
): void {
    const result = checkAccess(userId, project, permission, partition);
    if (!result.allowed) {
        throw new Error(`Access denied: ${result.reason}`);
    }
}

// ─── SQLite Persistence (lazy-init) ──────────────────────────

let dbInitialized = false;

function getRbacDbPath(): string {
    return join(process.env.PRISM_DATA_DIR || join(homedir(), ".prism"), "rbac.db");
}

export async function persistToDb(): Promise<void> {
    try {
        // @ts-ignore — dynamic import of optional dependency
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(getRbacDbPath());

        db.exec(`
            CREATE TABLE IF NOT EXISTS rbac_custom_roles (
                name TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                perm_read INTEGER DEFAULT 0,
                perm_write INTEGER DEFAULT 0,
                perm_delete INTEGER DEFAULT 0,
                perm_admin INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rbac_assignments (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL,
                project TEXT NOT NULL,
                partition TEXT,
                assigned_by TEXT NOT NULL,
                assigned_at TEXT NOT NULL,
                expires_at TEXT,
                UNIQUE(user_id, role, project, partition)
            );
        `);

        // Persist custom roles
        const upsertRole = db.prepare(`
            INSERT OR REPLACE INTO rbac_custom_roles
            (name, display_name, perm_read, perm_write, perm_delete, perm_admin, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const role of customRoles.values()) {
            upsertRole.run(
                role.name, role.displayName,
                role.permissions.read ? 1 : 0,
                role.permissions.write ? 1 : 0,
                role.permissions.delete ? 1 : 0,
                role.permissions.admin ? 1 : 0,
                role.createdAt,
            );
        }

        // Persist assignments
        const upsertAssign = db.prepare(`
            INSERT OR REPLACE INTO rbac_assignments
            (id, user_id, role, project, partition, assigned_by, assigned_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const assigns of assignments.values()) {
            for (const a of assigns) {
                upsertAssign.run(a.id, a.userId, a.role, a.project, a.partition || null, a.assignedBy, a.assignedAt, a.expiresAt || null);
            }
        }

        db.close();
        dbInitialized = true;
        debugLog("RBAC: Persisted state to SQLite");
    } catch (err) {
        debugLog(`RBAC: Persistence failed (non-fatal): ${err}`);
    }
}

export async function loadFromDb(): Promise<void> {
    try {
        // @ts-ignore
        const Database = (await import("better-sqlite3")).default;
        const dbPath = getRbacDbPath();

        // Check if DB exists before trying to open
        const { existsSync } = await import("node:fs");
        if (!existsSync(dbPath)) return;

        const db = new Database(dbPath);

        // Load custom roles
        const roles = db.prepare("SELECT * FROM rbac_custom_roles").all() as any[];
        for (const r of roles) {
            customRoles.set(r.name, {
                name: r.name,
                displayName: r.display_name,
                permissions: {
                    read: !!r.perm_read,
                    write: !!r.perm_write,
                    delete: !!r.perm_delete,
                    admin: !!r.perm_admin,
                },
                isBuiltin: false,
                createdAt: r.created_at,
            });
        }

        // Load assignments
        const assigns = db.prepare("SELECT * FROM rbac_assignments").all() as any[];
        for (const a of assigns) {
            const key = assignmentKey(a.user_id, a.project);
            const existing = assignments.get(key) || [];
            existing.push({
                id: a.id,
                userId: a.user_id,
                role: a.role,
                project: a.project,
                partition: a.partition || undefined,
                assignedBy: a.assigned_by,
                assignedAt: a.assigned_at,
                expiresAt: a.expires_at || undefined,
            });
            assignments.set(key, existing);
        }

        db.close();
        debugLog(`RBAC: Loaded ${roles.length} custom roles, ${assigns.length} assignments from DB`);
    } catch (err) {
        debugLog(`RBAC: Load failed (non-fatal, using defaults): ${err}`);
    }
}

debugLog("v12.3: RBAC engine loaded");
