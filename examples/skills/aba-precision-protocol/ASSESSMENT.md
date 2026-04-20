# Synalux ABA Behavioral Improvement Assessment

## Test Suite Results

```
✅ 24/24 tests pass on Synalux engine

Rule 1: Observable, Measurable Goals     — 13/13 ✅
Rule 2: Slow and Precise Execution       —  4/4  ✅
Rule 3: Intermittent Reinforcement Detect —  6/6  ✅
Full ABA Protocol Integration            —  1/1  ✅
```

---

## Assessment: 6 Domains Where ABA Behavioral Concepts Can Improve Synalux

### Domain 1: AI Chat Behavior (Current → ABA-Improved)

**Current state**: The AI chat (`route.ts`) has a safety prompt but no behavioral shaping. It either responds correctly or incorrectly — no feedback loop, no error detection, no self-correction.

| ABA Rule | Current Problem | Proposed Improvement |
|----------|----------------|---------------------|
| **Rule 1** | AI goals are vague ("be helpful") | Define observable response criteria per role: Doctor must use clinical terminology, Medical Technician must produce structured ABC data |
| **Rule 2** | AI generates entire response at once | Implement step-by-step generation: (1) identify question type → (2) select role context → (3) generate → (4) self-verify against role criteria |
| **Rule 3** | Wrong outputs (false denials) reinforced across sessions | Add a **behavioral feedback loop**: log user corrections, track wrong-pattern frequency, auto-adjust system prompt weights |

#### Concrete Implementation
```typescript
// In route.ts: Add behavioral self-check before returning
const selfCheck = {
  goalObservable: responseContainsActionableContent(response),
  roleAligned: responseMatchesRoleSkills(role, response),
  noFalseNegations: !containsFalseCapabilityDenial(response),
};
if (!selfCheck.noFalseNegations) {
  // STOP — don't send wrong response. Regenerate.
  response = await regenerateWithCorrection(prompt, selfCheck);
}
```

---

### Domain 2: SOAP Note Quality Assurance

**Current state**: SOAP notes are generated in one pass (`/api/v1/soap`). No verification that each section (S/O/A/P) meets clinical standards. No IOA check.

| ABA Rule | Current Problem | Proposed Improvement |
|----------|----------------|---------------------|
| **Rule 1** | "Generate SOAP note" is not observable | Observable goal: "Each section must contain ≥2 clinically relevant data points, Assessment must reference specific behavior data from Objective" |
| **Rule 2** | All 4 sections generated at once | Generate S → verify → O → verify → A → verify → P → verify. Stop and re-generate any section that fails clinical criteria |
| **Rule 3** | If Subjective is weak, Assessment is also weak (error compounds) | Section-by-section validation prevents error propagation |

#### Concrete Implementation
```typescript
// In soap/route.ts: Step-by-step generation with verification
async function generateSOAPWithABA(dictation: string) {
  // Step 1: Generate Subjective
  const S = await generateSection('subjective', dictation);
  if (!verifySectionCriteria(S, 'subjective')) {
    S = await regenerateSection('subjective', dictation, getCriteria('subjective'));
  }

  // Step 2: Generate Objective (depends on verified S)
  const O = await generateSection('objective', dictation, { subjective: S });
  if (!verifySectionCriteria(O, 'objective')) { /* stop-fix-verify */ }

  // Step 3: Assessment must reference data from O
  const A = await generateSection('assessment', dictation, { subjective: S, objective: O });
  if (!verifyAssessmentReferencesData(A, O)) { /* stop-fix-verify */ }

  // Step 4: Plan must address targets from A
  const P = await generateSection('plan', dictation, { assessment: A });
  if (!verifyPlanAddressesTargets(P, A)) { /* stop-fix-verify */ }

  return { S, O, A, P };
}
```

---

### Domain 3: ABC Data Collection (Sessions Page)

**Current state**: The sessions page ([sessions/page.tsx](../../../../synalux-private/portal/src/app/app/sessions/page.tsx)) has ABC buttons but NO validation. RBTs/Medical Technicians can select any combination without behavioral constraints.

| ABA Rule | Current Problem | Proposed Improvement |
|----------|----------------|---------------------|
| **Rule 1** | No IOA mechanism — single observer data only | Add **dual-entry IOA**: two technicians collect same data, system calculates agreement. Flag if IOA < 80% |
| **Rule 2** | A-B-C recorded in one click, no verification | After recording, show "Verify: A: Task Demand → B: Aggression → C: Redirection — Correct?" prompt. Timer pauses during verification |
| **Rule 3** | Incorrect data entry is silently accepted | **Real-time pattern alerts**: if same A→B→C sequence is logged 5+ times consecutively, prompt "This pattern is being recorded repeatedly. Please verify this is accurate, not habitual selection" |

#### Concrete Implementation
```typescript
// In sessions/page.tsx: Add verification step
const recordEntry = () => {
  if (!selectedA || !selectedB || !selectedC) return;

  // RULE 2: Verify before committing
  setVerificationPending({
    antecedent: selectedA,
    behavior: selectedB,
    consequence: selectedC,
  });
  // Show confirmation modal — don't commit until verified
};

// RULE 3: Detect habitual selection patterns
const detectRepetitivePattern = (entries: ABCEntry[]) => {
  const last5 = entries.slice(0, 5);
  const pattern = `${last5[0]?.antecedent}-${last5[0]?.behavior}-${last5[0]?.consequence}`;
  const matches = last5.filter(e =>
    `${e.antecedent}-${e.behavior}-${e.consequence}` === pattern
  );
  if (matches.length >= 4) {
    return { detected: true, pattern, count: matches.length };
  }
  return { detected: false };
};
```

---

### Domain 4: Session Monitoring & Trend Analysis

**Current state**: No trend analysis. ABC data is collected but never analyzed for behavioral patterns.

| ABA Rule | Current Problem | Proposed Improvement |
|----------|----------------|---------------------|
| **Rule 1** | No measurable outcome tracking | Dashboard showing: rate of target behavior per session (observable: "Aggression decreased from 8/hr to 3/hr over 4 weeks") |
| **Rule 2** | All sessions treated equally | Per-session graphs with trend lines. Each session's data individually verified before aggregation |
| **Rule 3** | If data collection is inconsistent, trends are misleading | Flag sessions where data patterns deviate >2 SD from baseline — possible collection error, not behavior change |

---

### Domain 5: Treatment Plan (BIP) Generation

**Current state**: FBA/BIP generation is mentioned in docs but relies entirely on free-form AI chat — no structured workflow.

| ABA Rule | Proposed Improvement |
|----------|---------------------|
| **Rule 1** | BIP must contain: (1) operational definition of target behavior, (2) measurable replacement behavior, (3) specific criteria for mastery |
| **Rule 2** | Generate in phases: Operational Definition → Function Hypothesis → Replacement Behavior → Intervention Strategies → Mastery Criteria. Verify each against Cooper, Heron & Heward |
| **Rule 3** | If operational definition is vague, entire BIP is flawed. Block progression until definition passes "stranger test" (could a stranger identify the behavior from this description alone?) |

---

### Domain 6: Developer Workflow (Extension + CI)

**Current state**: The `fix-without-asking` and `github-ci-verification` skills exist but aren't enforced in code.

| ABA Rule | Proposed Improvement |
|----------|---------------------|
| **Rule 1** | Every git push must have an observable verification: "build passes AND Vercel READY AND no new lint errors" |
| **Rule 2** | Pre-commit hooks that run tests. CI won't pass without verification step completion |
| **Rule 3** | Track CI failure patterns. If the same type of failure occurs 3+ times (e.g., regex in webview), add a targeted linter rule to prevent it permanently |

---

## Priority Roadmap

| Priority | Domain | Impact | Effort |
|----------|--------|--------|--------|
| 🔴 **P0** | Domain 3: ABC verification step | Prevents bad data at source | Small — UI change only |
| 🔴 **P0** | Domain 1: AI false-denial prevention | User trust | Small — self-check in route.ts |
| 🟡 **P1** | Domain 3: IOA dual-entry | Clinical compliance | Medium — new workflow |
| 🟡 **P1** | Domain 2: Section-by-section SOAP | Note quality | Medium — refactor soap/route.ts |
| 🟡 **P1** | Domain 4: Trend dashboard | Clinical value | Medium — new reports page |
| 🟢 **P2** | Domain 5: Structured BIP workflow | Feature expansion | Large — new page + API |
| 🟢 **P2** | Domain 3: Repetitive pattern detection | Data integrity | Small — client-side logic |
| 🟢 **P2** | Domain 6: CI failure pattern tracking | Dev reliability | Medium — linter + skill update |

---

## Key Insight

Synalux is an **ABA practice management platform** that doesn't yet apply ABA principles to itself. The same 3 rules that fix agent behavior can fix clinical data collection, note quality, and treatment planning:

1. **Observable goals** → every clinical output has measurable criteria
2. **Step-by-step verification** → each section/entry is verified before proceeding
3. **Prevent reinforcement of errors** → catch bad data before it compounds into wrong clinical decisions

> The platform should practice what it preaches.
