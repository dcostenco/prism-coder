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

    it("names the section that is absent", () => {
        const withoutRules = COMPLETE_BIP.replace(
            /Decision rules:[\s\S]*?one instance\./,
            "",
        );
        const r = passesClinicalQualityGate(PLAN_PROMPT, withoutRules);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("clinical_plan_sections_missing");
        expect(r.sections?.missing).toContain("decision_rules");
    });

    it("reports a count even when it passes, so the header states what was checked", () => {
        const r = passesClinicalQualityGate(PLAN_PROMPT, COMPLETE_BIP);
        expect(r.sections).toBeDefined();
        expect(r.sections!.required).toBeGreaterThan(5);
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
