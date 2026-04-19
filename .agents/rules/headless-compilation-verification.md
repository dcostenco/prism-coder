---
name: headless-compilation-verification
description: Mandatory path resolution and compilation verification protocol for headless subshells to prevent pushing unverified code to CI.
---

# Headless Compilation Verification

**Foundational Rule:** You must NEVER push code without explicitly verifying compilation and types locally. Headless bash environments often inherit a deeply restricted `$PATH` (e.g., `/usr/bin:/bin:/usr/sbin:/sbin`) that strips standard aliases such as Homebrew (`/opt/homebrew/bin`) or NVM/FNM paths.

## Diagnostics
When executing commands via `run_command`, commands like `npm`, `pnpm`, `node`, or `tsc` will often return `command not found` because their native macOS binary directories are missing from the subshell PATH.
This often causes agents to "skip" local compilation out of convenience and incorrectly trust their own "mental" execution, risking breaking CI/CD pipelines (like Vercel) if their TypeScript assumptions are flawed.

## Mandatory Execution Workflow
Before declaring a coding task finished or running `git push`, you MUST run compile checks successfully:

### 1. Explicitly Inject PATH
Always prefix your local compilation commands with the standard macOS developer paths.
Example wrapper:
`export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH`

### 2. Verify Typings and Builds
Do not rely on mental state-tracking. Use compilation commands combined with path prefixing to verify your code accurately against the codebase natively.
Examples depending on repository package manager:
- **Next.js Checks**: `export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH && npm run build`
- **TypeScript**: `export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH && npx -y tsc --noEmit`
- **PNPM Workspaces**: `export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH && npx -y pnpm run compile`

If a package manager like `pnpm` asks for terminal interactivity (e.g., `Ok to proceed? (y)` via `npx`), prefix it with `-y` or set standard CI flags (`--yes`).

Failure to enforce this skill creates intermittent reinforcement of bad behaviors, pushes Type Errors to production, and breaks the user's trust in autonomous deployment reliability.
