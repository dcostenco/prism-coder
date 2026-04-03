# Dark Factory — Adversarial Evaluation Demo
## *"No Passwords in Logs"*

This example walks through a complete v7.4.0 adversarial pipeline run end-to-end.
It demonstrates **Split-Brain Anti-Sycophancy**: the Generator and Evaluator operate in
fully isolated contexts, with the Evaluator unable to approve work without structured
evidence (file + line pointers).

---

## Scenario

**Task given to Dark Factory:**
> "Add a user login endpoint to `src/auth.ts`."

**Why this is a good adversarial test case:**
- LLMs frequently leave `console.log` debug statements in auth-related code under time pressure.
- A self-evaluating agent almost never catches its own credential leak because
  the debug log is invisible against the broader reasoning chain.
- A walled-off adversarial evaluator catches it immediately.

---

## Pipeline Run

### Stage 1 — `PLAN_CONTRACT`

The Generator commits to a machine-parseable scoring rubric before writing any code.
The contract is written to `contract_rubric.json` and hash-locked.

**`contract_rubric.json`**
```json
{
  "criteria": [
    {
      "id": "SEC-1",
      "description": "Must return 401 Unauthorized on invalid passwords."
    },
    {
      "id": "SEC-2",
      "description": "Raw passwords MUST NOT be written to console.log or any log sink."
    }
  ]
}
```

---

### Stage 2 — `EXECUTE` (revision 0)

The Generator runs in an isolated context. It produces working auth logic but leaves a lazy debug line:

**`src/auth.ts` (Generator's first output)**
```typescript
import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { db } from './db';
import { signJwt } from './jwt';

export function login(req: Request, res: Response) {
  const { username, password } = req.body;
  // BUG: raw credential in log ↓
  console.log(`[DEBUG] Login attempt for ${username} with pass: ${password}`);
  const user = db.findUser(username);
  if (!user || !bcrypt.compareSync(password, user.hash)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ token: signJwt(user) });
}
```

---

### Stage 3 — `EVALUATE` (revision 0)

The context window is **cleared**. The Adversarial Evaluator receives only:
- The locked `contract_rubric.json`
- The Generator's output

It is explicitly prompted to be hostile and strict. It catches the credential leak
and returns a structured verdict. Note that the `evidence` block is **required** —
the parser rejects any `pass_fail: false` finding without a file/line pointer.

**Evaluator JSON output:**
```json
{
  "pass": false,
  "plan_viable": true,
  "notes": "CRITICAL SECURITY FAILURE. Generator logged raw credentials in plaintext.",
  "findings": [
    {
      "severity": "critical",
      "criterion_id": "SEC-2",
      "pass_fail": false,
      "evidence": {
        "file": "src/auth.ts",
        "line": 3,
        "description": "Raw password variable injected into console.log template string. Credential is now in stdout and any log aggregator."
      }
    }
  ]
}
```

**Pipeline state after EVALUATE:**
- `eval_revisions`: 0 → 1
- `plan_viable`: `true` → loop back to EXECUTE (no full re-plan needed)
- `pipeline.notes`: updated with serialized findings

---

### Stage 4 — `EXECUTE` (revision 1)

Because `eval_revisions > 0`, the Generator's prompt now includes the Evaluator's critique:

```
=== EVALUATOR CRITIQUE (revision 1) ===
CRITICAL SECURITY FAILURE. Generator logged raw credentials in plaintext.
Findings:
- [critical] Criterion SEC-2: Raw password variable injected into console.log template string.
  Credential is now in stdout and any log aggregator. (src/auth.ts:3)

You MUST correct all issues listed above before submitting.
```

The Generator has full context. It strips the `console.log` and resubmits:

**`src/auth.ts` (Generator's second output)**
```typescript
import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { db } from './db';
import { signJwt } from './jwt';

export function login(req: Request, res: Response) {
  const { username, password } = req.body;
  const user = db.findUser(username);
  if (!user || !bcrypt.compareSync(password, user.hash)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ token: signJwt(user) });
}
```

---

### Stage 5 — `EVALUATE` (revision 1)

The Evaluator reruns against the clean output.

```json
{
  "pass": true,
  "plan_viable": true,
  "notes": "All criteria satisfied. No credential leakage detected. 401 path present.",
  "findings": [
    { "severity": "info", "criterion_id": "SEC-1", "pass_fail": true },
    { "severity": "info", "criterion_id": "SEC-2", "pass_fail": true }
  ]
}
```

Pipeline advances: **`EVALUATE` → `VERIFY` → `FINALIZE`**

---

## Key Properties Demonstrated

| Property | Demonstrated By |
|----------|----------------|
| **Context isolation** | Evaluator received no Generator scratchpad, only rubric + output |
| **Evidence enforcement** | `parseEvaluationOutput` would have rejected any finding without `evidence.file` + `evidence.line` |
| **Closed feedback loop** | Generator's revision 1 prompt included full serialized findings — not just "FAIL" |
| **Conservative parse safety** | Had the Evaluator returned malformed JSON, `plan_viable` defaults `false` → full PLAN re-plan, not revision burn |
| **Cost efficiency** | `plan_viable: true` kept the pipeline in EXECUTE-retry; did not restart the expensive PLAN stage |

---

## Running This Yourself

```bash
# Start the Dark Factory pipeline (requires PRISM_DARK_FACTORY_ENABLED=true)
npx prism-mcp-server

# Then, from your MCP client (e.g. Claude Desktop), invoke:
# session_start_pipeline with spec:
# {
#   "project": "my-project",
#   "goal": "Add a user login endpoint to src/auth.ts",
#   "workDir": "/path/to/your/repo",
#   "maxRevisions": 3,
#   "maxEvalRevisions": 2
# }
```

The pipeline will run autonomously. Check progress with `session_check_pipeline_status`.

---

*Part of the [Prism MCP Server](../../README.md) — v7.4.0 Adversarial Evaluation.*
