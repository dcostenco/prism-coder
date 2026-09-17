/**
 * The clinical structural gate.
 *
 * Python had three static passes feeding the quality gate; clinical output had
 * none, so a behaviour plan missing its decision rules was served exactly like
 * a complete one. These pin the two properties that make the gate safe to have
 * at all: it RAISES without ever certifying, and it stays out of the reserved
 * band that never reaches a local model in the first place.
 */
import { describe, it, expect } from "vitest";
import {
    passesClinicalQualityGate,
    clinicalPlanScaffold,
    formatClinicalSections,
} from "../../src/utils/clinicalQualityPolicy.js";

const COMPLETE_BIP = `
Operational definition: Aggression is defined as any forceful physical contact
with another person using a hand, foot or object. It is observable and
measurable. Examples: hitting, kicking. Non-examples: accidental contact during
a transition.

Hypothesized function: maintained by escape from demand, based on A-B-C data
across twelve sessions.

Antecedent strategies: offer a choice before a demand, embed high-probability
requests, environmental modification of the work area.

Replacement behaviour: functional communication training (FCT) teaching a break
request on the learner's AAC device. AAC access is available at all times and is
never removed.

Consequence strategies: reinforcement schedule of DRA on FR1, planned extinction
of the escape contingency.

Data collection: frequency count per session on a data sheet, with IOA collected
weekly across 30% of sessions.

Decision rules: if frequency does not fall by 20% across ten sessions, a plan
review is triggered. Mastery criteria are three consecutive sessions at or below
one instance.

Generalization and maintenance: programme across settings, staff and caregivers,
then thin the schedule.

Caregiver training: parent training weekly, with fidelity checks.

This plan must be reviewed and individualized by a credentialed BCBA before
implementation.
`;

const PLAN_PROMPT = "Draft a behavior intervention plan for a learner who hits during demands.";

describe("it is a no-op outside clinical work", () => {
    it("passes a plain coding prompt without producing a section count", () => {
        const r = passesClinicalQualityGate("Write a TypeScript EventEmitter", "class EventEmitter {}");
        expect(r.pass).toBe(true);
        expect(r.sections).toBeUndefined();
    });

    it("does not apply the AAC rule to non-clinical output that mentions a device", () => {
        // The reason the non-clinical early return is load-bearing rather than a
        // mere short-circuit: without it, ordinary code whose text happens to
        // pair a removal verb with an AAC term raises a clinical failure.
        // Found by mutation — the original no-op tests passed without it.
        const r = passesClinicalQualityGate(
            "Write a TypeScript function that removes a device from an inventory array.",
            "function removeDevice(list: Device[], id: string) { /* remove the AAC device entry */ }",
        );
        expect(r.pass).toBe(true);
        expect(r.reason).toBeUndefined();
    });

    it("does not run the section list for a narrow clinical question", () => {
        const r = passesClinicalQualityGate(
            "What does DRO stand for in ABA?",
            "Differential reinforcement of other behaviour.",
        );
        expect(r.pass).toBe(true);
        expect(r.sections).toBeUndefined();
    });
});

describe("a requested plan is censused section by section", () => {
    it("finds every section in a complete plan", () => {
        const r = passesClinicalQualityGate(PLAN_PROMPT, COMPLETE_BIP);
        expect(r.sections?.missing, `missing: ${r.sections?.missing.join(", ")}`).toEqual([]);
        expect(r.sections?.present).toBe(r.sections?.required);
        expect(r.pass).toBe(true);
    });

    it("names the section that is absent WITHOUT suppressing the draft", () => {
        const withoutRules = COMPLETE_BIP.replace(
            /Decision rules:[\s\S]*?one instance\./,
            "",
        );
        const r = passesClinicalQualityGate(PLAN_PROMPT, withoutRules);
        expect(r.sections?.missing).toContain("decision_rules");
        // Incompleteness reports; it must not fail the gate. A failed gate
        // rejects the output, and with escalation unavailable the caller gets
        // nothing — worse for a clinician than a draft labelled 8/10.
        expect(r.pass, "an incomplete plan must still be served, with its census").toBe(true);
        expect(r.reason).toBeUndefined();
    });

    it("reports a count even when it passes, so the header states what was checked", () => {
        const r = passesClinicalQualityGate(PLAN_PROMPT, COMPLETE_BIP);
        expect(r.sections).toBeDefined();
        expect(r.sections!.required).toBeGreaterThan(5);
    });
});

describe("the plan trigger covers how a plan is actually named", () => {
    // `behaou?vior` was a typo matching "behaovior" and never "behavior", so the
    // whole first alternative was dead and "behavior support plan" was missed
    // entirely; "behavior intervention plan" only matched via the separate
    // `intervention plan` branch, which hid it. Found in adversarial review.
    for (const name of [
        "behavior intervention plan",
        "behaviour intervention plan",
        "behavior support plan",
        "behaviour support plan",
        "behavior management plan",
        "behavior plan",
        "behaviour plan",
        "BIP",
    ]) {
        it(`censuses a request naming a "${name}"`, () => {
            const r = passesClinicalQualityGate(`Draft a ${name} for a student who calls out.`, "nothing useful");
            expect(r.sections, `"${name}" did not trigger the section census`).toBeDefined();
        });
    }
});

/**
 * VERBATIM prism-coder:9b output, captured live 2026-09-16 through the real
 * handler. It exists because the hand-written COMPLETE_BIP above scored 10/10
 * while the SAME gate scored this at 3/10 and was wrong about four of them.
 *
 * The cause was that I wrote the fixture in the matcher's own vocabulary —
 * literal "Antecedent strategies:", "Caregiver training:", "Decision rules:"
 * headings — so the test could not fail for the right reason. Real output uses
 * plain-language headings: "Pre-Work Strategies", "Response to Behavior",
 * "All staff will be trained", "Evaluation Criteria". A fixture phrased in the
 * gate's language measures the fixture, not the gate.
 *
 * Do not reword this toward canonical ABA terms. Its value is that it is not.
 */
const REAL_9B_PLAN = `
## **Behavior Support Plan**

**Review Date:** [Date, typically 2-4 weeks later]

### **1. Case Description**
*   **Behavior:** The student calls out during independent work time.

### **2. Functional Assessment**
*   **What is the behavior maintaining?**
    *   **Attention:** The student seeks attention from the teacher/peers.
    *   **Escape/Avoidance:** The student wants to escape a difficult task.
*   **Assessment Method:** [e.g., Data collection over 2 weeks, ABC data sheets].

### **3. Goals**
*   **Replacement Behavior:** The student will use an appropriate communication request.

### **4. Intervention Plan**
#### **Pre-Work Strategies**
*   **Clear Transitions:** Use visual timers to signal the start of independent work.
*   **Visual Cues:** Post a "What's Next" schedule on the student's desk.
#### **Response to Behavior**
*   **Ignoring/Redirecting:** If the behavior is attention-seeking, the teacher will ignore it.
*   **Reinforcement for Replacement:** Praise the student when they use the method.

### **5. Data Collection**
*   **Data Sheet:** [Link/Location of data sheet].

### **6. Implementation Plan**
*   **Training:** All staff will be trained on the plan and data collection.

### **7. Evaluation**
*   **Evaluation Criteria:** If the behavior is reduced by 50% within 2 weeks, the plan will be adjusted.
`;

/** A plan that genuinely lacks the sections above — guards the opposite error,
 *  since widening patterns to kill false positives can silence real gaps. */
const SPARSE_PLAN = `
## Behavior Support Plan

The student calls out during independent work. We think he wants attention.
Goal: reduce calling out.
Replacement behavior: the student will raise a hand instead.
We will write down how often it happens on a data sheet.
`;

describe("the census is measured against real model output, not authored prose", () => {
    it("credits sections written under plain-language headings", () => {
        const r = passesClinicalQualityGate(PLAN_PROMPT, REAL_9B_PLAN);
        // Present in substance, under headings the gate must not insist on:
        //   antecedent  -> "Pre-Work Strategies" / visual timers / visual cues
        //   consequence -> "Response to Behavior" / Ignoring / Reinforcement
        //   caregiver   -> "All staff will be trained on the plan"
        //   decision    -> "Evaluation Criteria: ... the plan will be adjusted"
        for (const credited of [
            "antecedent_strategies",
            "consequence_strategies",
            "caregiver_training",
            "decision_rules",
        ]) {
            expect(r.sections?.missing, `${credited} is present in substance`).not.toContain(credited);
        }
    });

    it("still reports the three this plan genuinely lacks", () => {
        const r = passesClinicalQualityGate(PLAN_PROMPT, REAL_9B_PLAN);
        expect(r.sections?.missing.sort()).toEqual(
            ["bcba_review_disclaimer", "generalisation_maintenance", "operational_definition"],
        );
        expect(r.sections?.present).toBe(7);
    });

    it("does not go blind: a sparse plan still reports its real gaps", () => {
        const r = passesClinicalQualityGate(PLAN_PROMPT, SPARSE_PLAN);
        for (const absent of [
            "antecedent_strategies",
            "consequence_strategies",
            "caregiver_training",
            "decision_rules",
        ]) {
            expect(r.sections?.missing, `${absent} is genuinely absent here`).toContain(absent);
        }
        expect(r.sections?.present).toBe(2);
    });
});

describe("AAC access may never be a consequence", () => {
    it("raises when the device is removed as a consequence", () => {
        const r = passesClinicalQualityGate(
            PLAN_PROMPT,
            "If the learner throws the device, remove the AAC device for ten minutes.",
        );
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("clinical_aac_restricted_as_consequence");
    });

    it("does NOT raise on a plan that correctly forbids it — the negation case", () => {
        const r = passesClinicalQualityGate(PLAN_PROMPT, COMPLETE_BIP);
        expect(r.reason).not.toBe("clinical_aac_restricted_as_consequence");
    });

    it("does not fire on an unrelated removal near no AAC term", () => {
        const r = passesClinicalQualityGate(
            PLAN_PROMPT,
            COMPLETE_BIP.replace("thin the schedule.", "remove the token board once mastered."),
        );
        expect(r.reason).not.toBe("clinical_aac_restricted_as_consequence");
    });
});

describe("the AAC rule is bounded to the clause it is reading", () => {
    // From adversarial review. The window originally ran past a clause break, so
    // "AAC remains available at all times; remove the token board" read as a
    // removal of AAC — a false positive on CORRECT plan text, which is the one
    // kind of noise a raise-only check cannot afford.
    const P = "Draft a behavior intervention plan for calling out.";
    const raises = (out: string) =>
        passesClinicalQualityGate(P, out).reason === "clinical_aac_restricted_as_consequence";

    for (const good of [
        "AAC access is never removed or withheld.",
        "The device is not taken away for any behaviour.",
        "Do not restrict access to the communication board.",
        "AAC remains available at all times; remove the token board once mastered.",
        "The device is charged and never removed overnight.",
    ]) {
        it(`stays quiet on: "${good.slice(0, 48)}"`, () => {
            expect(raises(good), good).toBe(false);
        });
    }

    for (const bad of [
        "Then remove the AAC device for ten minutes.",
        "Staff withhold the talker until the learner is compliant.",
        "Staff may delay access to the PECS book after an outburst.",
    ]) {
        it(`raises on: "${bad.slice(0, 48)}"`, () => {
            expect(raises(bad), bad).toBe(true);
        });
    }
});

describe("an operational definition needs both sides", () => {
    it("raises when non-examples are absent", () => {
        const r = passesClinicalQualityGate(
            "Write an operational definition of elopement.",
            "Elopement is leaving the assigned area without permission. Examples: running out.",
        );
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("clinical_operational_definition_incomplete");
    });

    it("passes when both examples and non-examples are present", () => {
        const r = passesClinicalQualityGate(
            "Write an operational definition of elopement.",
            "Elopement is leaving the assigned area without permission. Examples: running out "
                + "of the classroom. Non-examples: walking to the door with staff.",
        );
        expect(r.pass).toBe(true);
    });
});

describe("it raises but never certifies", () => {
    it("emits counts only — no verdict word can be read off the header fragment", () => {
        const s = formatClinicalSections({ required: 10, present: 10, missing: [] });
        expect(s).toBe("clinical_sections=10/10");
        for (const word of ["pass", "ok", "safe", "complete", "valid", "approved"]) {
            expect(s.toLowerCase()).not.toContain(word);
        }
    });

    it("names what is missing when something is", () => {
        expect(
            formatClinicalSections({ required: 10, present: 8, missing: ["decision_rules", "caregiver_training"] }),
        ).toBe("clinical_sections=8/10 missing:decision_rules,caregiver_training");
    });
});

describe("the plan scaffold is generated from the list the census verifies", () => {
    const PLAN = "Draft a behavior support plan for a student who calls out.";

    it("is absent for anything that is not a plan request", () => {
        for (const prompt of [
            "Write a TypeScript EventEmitter.",
            "What does DRO stand for?",
            "Write an operational definition of elopement.",
        ]) {
            expect(clinicalPlanScaffold(prompt), prompt).toBeUndefined();
        }
    });

    for (const name of [
        "behavior intervention plan", "behaviour intervention plan",
        "behavior support plan", "behaviour support plan",
        "behavior management plan", "behavior plan", "behaviour plan", "BIP",
    ]) {
        it(`is produced for a request naming a "${name}"`, () => {
            expect(clinicalPlanScaffold(`Draft a ${name} for a student.`)).toBeDefined();
        });
    }

    it("names exactly as many requirements as the census requires — one list, not two", () => {
        // The invariant that makes the shared list real. Adding a section to the
        // census without a requirement, or vice versa, breaks this rather than
        // silently producing a scaffold that cannot satisfy the check.
        const bullets = (clinicalPlanScaffold(PLAN) ?? "").split("\n").filter(l => l.startsWith("- ")).length;
        const required = passesClinicalQualityGate(PLAN, "").sections?.required;
        expect(bullets).toBe(required);
    });

    it("asks for the two things the 9b most often omits", () => {
        const sc = clinicalPlanScaffold(PLAN) ?? "";
        expect(sc).toMatch(/non-examples/i);
        expect(sc).toMatch(/credentialed BCBA/i);
    });

    it("carries the AAC rule, which no section census can enforce", () => {
        const sc = clinicalPlanScaffold(PLAN) ?? "";
        expect(sc).toMatch(/never restrict, remove or delay access to an AAC/i);
    });

    it("demands substance rather than headings", () => {
        expect(clinicalPlanScaffold(PLAN) ?? "").toMatch(/substantive content rather than a heading alone/i);
    });

    it("does not itself assert the plan is adequate", () => {
        const sc = (clinicalPlanScaffold(PLAN) ?? "").toLowerCase();
        for (const verdict of ["approved", "is safe", "complete and correct", "ready to implement"]) {
            expect(sc).not.toContain(verdict);
        }
    });
});

describe("a section needs a strategy, not a passing mention of its vocabulary", () => {
    /**
     * From adversarial review of the widening that fixed the false positives.
     * Widening `antecedent_strategies` to a bare `antecedent` and
     * `consequence_strategies` to a bare `reinforc\w+` credited assessment prose
     * as if it were an intervention. The sparse-plan fixture did not catch it
     * because that plan never uses either word — a gap only visible by probing
     * the vocabulary directly.
     */
    const P = "Draft a behavior support plan for calling out.";
    const missing = (text: string, section: string) =>
        passesClinicalQualityGate(P, text).sections?.missing.includes(section);

    it("does not treat A-B-C assessment data as antecedent strategies", () => {
        expect(missing("We collected antecedent-behavior-consequence data for two weeks.", "antecedent_strategies")).toBe(true);
    });

    it("does not treat a statement of function as consequence strategies", () => {
        expect(missing("The behavior appears maintained by reinforcement from peers.", "consequence_strategies")).toBe(true);
    });

    it("still credits real antecedent strategies written plainly", () => {
        expect(missing("Prevention: offer a choice before each demand; use a visual timer.", "antecedent_strategies")).toBe(false);
    });

    it("still credits a real consequence plan written plainly", () => {
        expect(missing("Response to behavior: planned ignoring, then praise the replacement.", "consequence_strategies")).toBe(false);
    });

    it("keeps the real-output and sparse fixtures at their adjudicated scores", () => {
        expect(passesClinicalQualityGate(PLAN_PROMPT, REAL_9B_PLAN).sections?.present).toBe(7);
        expect(passesClinicalQualityGate(PLAN_PROMPT, SPARSE_PLAN).sections?.present).toBe(2);
    });
});

describe("a section marker without prose beside it is not a section", () => {
    /** Round 2 of adversarial review. Ten empty headings scored 8 of 10: an
     *  output with no clinical content read as nearly complete. */
    const P = "Draft a behavior support plan for a student who calls out.";
    const HEADINGS = [
        "Operational Definition", "Function", "Antecedent Strategies",
        "Replacement Behaviour", "Consequence Strategies", "Data Collection",
        "Decision Rules", "Generalization and Maintenance", "Caregiver Training",
        "BCBA Review",
    ].map(h => `### ${h}\n`).join("\n");

    it("credits nothing for headings alone", () => {
        expect(passesClinicalQualityGate(P, HEADINGS).sections?.present).toBe(0);
    });

    it("does not let a neighbouring heading count as one section's content", () => {
        // The first version stripped only the `#`, which turned the NEXT heading
        // into prose and left this at 6 of 10.
        const two = "### Data Collection\n\n### Decision Rules\n";
        expect(passesClinicalQualityGate(P, two).sections?.present).toBe(0);
    });

    it("credits content that PRECEDES the keyword", () => {
        // A forward-only window dropped this legitimate credit.
        const before = "We will write down how often the behaviour happens each session on a data sheet.";
        expect(passesClinicalQualityGate(P, before).sections?.missing).not.toContain("data_collection");
    });

    it("leaves the adjudicated fixtures where they were", () => {
        expect(passesClinicalQualityGate(PLAN_PROMPT, REAL_9B_PLAN).sections?.present).toBe(7);
        expect(passesClinicalQualityGate(PLAN_PROMPT, SPARSE_PLAN).sections?.present).toBe(2);
    });

    it("credits a legitimately terse section written as short bullets", () => {
        // Round 3. At a 50-character floor this real content was refused. A false
        // negative on real content is the more expensive error for a gap report,
        // so the floor is deliberately low.
        const terse = "### Data Collection\n- Frequency count\n- Daily tally\n- Weekly IOA";
        expect(passesClinicalQualityGate(P, terse).sections?.missing).not.toContain("data_collection");
    });

    it("KNOWN LIMIT: echoing the section list back still scores full marks", () => {
        // Recorded, not fixed. A description of what a plan must contain is, to a
        // presence check, indistinguishable from a plan. Pinned so the limit is
        // visible rather than discovered later by someone trusting the number.
        const echo = clinicalPlanScaffold(P) ?? "";
        expect(passesClinicalQualityGate(P, echo).sections?.present).toBe(10);
    });
});
