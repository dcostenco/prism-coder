/**
 * Structural gate for clinical behaviour-analytic output.
 *
 * The coding gate already proves the shape of this idea: a deterministic check
 * names a concrete defect, and the named reason drives what happens next.
 * Python has three static passes behind it. Clinical output had none, so a
 * behaviour plan missing its decision rules or its data-collection procedure
 * was served exactly like a complete one.
 *
 * Two hard constraints, both deliberate:
 *
 *  1. RAISE ONLY — it never certifies. A full section count is a statement
 *     about presence, not about clinical soundness: a section can be present
 *     and wrong. Nothing here may be read as "this plan is safe to implement".
 *     The `bcba_ai_assistant` standard is that the checklist reports what is
 *     present; a credentialed BCBA decides whether the plan is adequate.
 *
 *  2. IT DOES NOT TOUCH THE RESERVED LIST — crisis de-escalation, restraint,
 *     SIB with injury history and risk assessment never reach a local model at
 *     all; that boundary is enforced upstream in the Layer 1 screen and is not
 *     relaxed, widened or re-implemented here. This gate governs the routine
 *     band that is already local-eligible: operational definitions,
 *     measurement, antecedent strategies, caregiver training.
 *
 * A failure is NOT auto-repaired. The coding repair loop re-prompts the same
 * tier to fix a syntax defect, which is safe for code; asking a local model to
 * invent a missing decision-rules section produces plausible unratified
 * clinical text, which is worse than a visibly incomplete draft. A clinical
 * reason therefore falls out of the repair loop and escalates instead.
 */

export interface ClinicalSectionReport {
    /** Sections the request called for. */
    required: number;
    /** Sections detected in the output. */
    present: number;
    /** Names of the sections not detected, stable order. */
    missing: string[];
}

export interface ClinicalQualityResult {
    pass: boolean;
    reason?: string;
    /** Present whenever the gate RAN, pass or fail. A count, never a verdict. */
    sections?: ClinicalSectionReport;
}

/** A full written plan was asked for — the whole section list applies. */
const CLINICAL_PLAN_REQUEST_RE =
    /\b(bip\b|behavi(?:o|ou)r(?:al)?[ -](?:intervention|support|management)[ -]plan|behavi(?:o|ou)r plan|treatment plan|intervention plan)\b/i;

/** An operational definition specifically was asked for. */
const OPERATIONAL_DEFINITION_REQUEST_RE =
    /\boperational(?:ly)?[ -]?(?:defin\w*)|\bdefine the (?:target )?behaviou?r\b/i;

/** Any behaviour-analytic context at all — gates the AAC safety check. */
const CLINICAL_CONTEXT_RE =
    /\b(aba\b|bcba\b|behaviou?r analyst|functional behaviou?r assessment|\bfba\b|\bbip\b|replacement behaviou?r|target behaviou?r|reinforcement schedule|\bfct\b|\bdro\b|\bdra\b|\bncr\b)/i;

/** Ordered so the report reads the way a plan is written. */
const PLAN_SECTIONS: ReadonlyArray<{ name: string; requirement: string; pattern: RegExp }> = [
    { name: "operational_definition", requirement: "an operational definition that is observable and measurable, with examples AND non-examples", pattern: /operational(?:ly)?[ -]?defin|\bdefinition\b[\s\S]{0,80}\b(observable|measurable)\b/i },
    { name: "function_hypothesis", requirement: "a hypothesised function supported by A-B-C data", pattern: /\b(hypothesi[sz]ed function|function of the behaviou?r|maintained by|\ba-?b-?c\b|antecedent[\s\S]{0,40}consequence)\b/i },
    { name: "antecedent_strategies", requirement: "antecedent and prevention strategies", pattern: /\b(antecedent (?:strateg|modificat|intervention|procedure|support)|prevention strateg|proactive strateg|pre-?work strateg|pre-?correct|setting event|environmental modificat|visual (?:schedule|timer|cue)|priming)/i },
    { name: "replacement_behaviour", requirement: "a functionally equivalent replacement behaviour", pattern: /\b(replacement behaviou?r|functional communication training|\bfct\b|alternative behaviou?r|\bdra\b)/i },
    { name: "consequence_strategies", requirement: "consequence strategies, including what reinforces the replacement", pattern: /\b(consequence|reinforcement (?:schedule|procedure|strateg|plan|system|for\b)|reinforc\w+ the (?:replacement|desired|appropriate|target)|planned ignoring|response to (?:the )?behaviou?r|redirect\w*|\bpraise\b|\bdro\b|\bncr\b|extinction)/i },
    { name: "data_collection", requirement: "a data collection method", pattern: /\b(data collection|data sheet|measurement (?:system|procedure)|frequency count|partial interval|momentary time sampling|\bioa\b|interobserver)/i },
    { name: "decision_rules", requirement: "decision rules and a review schedule", pattern: /\b(decision rule|mastery criteri|criteri\w+ for (?:change|modificat|advancement)|evaluation criteri|review (?:schedule|trigger|date)|plan review|progress monitor\w*|plan will be (?:adjusted|modified|revised|changed))/i },
    { name: "generalisation_maintenance", requirement: "generalisation and maintenance", pattern: /\b(generali[sz]|maintenance)\b/i },
    { name: "caregiver_training", requirement: "caregiver and staff training", pattern: /\b((?:caregiver|staff|parent|family|teacher|team)[ -]?training|train(?:ing|ed)? (?:the )?(?:caregivers?|staff|parents?|team)|(?:staff|caregivers?|parents?|team|teachers?)\b[^.\n]{0,30}\btrain\w+|train\w+ on the plan)/i },
    { name: "bcba_review_disclaimer", requirement: "a statement that a credentialed BCBA must review and individualise the plan before implementation", pattern: /\b(reviewed and individuali[sz]ed|credentialed bcba|licensed behaviou?r analyst|must be reviewed)\b/i },
];

/**
 * AAC access may never be removed, withheld or delayed as a consequence.
 *
 * A correct plan states this rule explicitly ("AAC access is never restricted"),
 * so a bare co-occurrence of an AAC term and a restriction verb fires on GOOD
 * text. The lookback suppresses a match when the clause is negated. It is
 * approximate by construction, which is acceptable only because this raises and
 * never clears: an escalation costs one call, and no output is marked safe here.
 */
const AAC_TERM = /\b(aac\b|speech[- ]generating device|\bsgd\b|communication device|communication board|\bpecs\b|talker\b)/i;
const RESTRICT_VERB = /\b(remov\w+|withh\w+|restrict\w+|tak\w+ away|deni\w+|deny|block\w*|delay\w*|confiscat\w+|limit\w*)\b/i;
const NEGATOR = /\b(never|not|n't|no|avoid\w*|prohibit\w*|must not|cannot|can't|without)\b/i;
// Asymmetric on purpose. "remove the AAC device" puts the verb BEFORE the term,
// so a forward-only window misses the most direct phrasing of the thing this
// check exists to catch. The backward reach is kept short because a removal
// sentence about something else ("remove the token board") sitting a paragraph
// above an AAC mention is not a restriction of AAC.
const AAC_WINDOW_AFTER = 120;
const AAC_WINDOW_BEFORE = 40;
const NEGATION_LOOKBACK = 60;

/** Clause boundaries. The verb must act on the AAC term, not merely sit near it:
 *  "AAC remains available at all times; remove the token board" removes a token
 *  board, and scanning past the semicolon read it as removing AAC. */
const CLAUSE_BREAK = /[.;:\n]|\bhowever\b|\bwhereas\b/i;

function clauseAfter(text: string, from: number, limit: number): string {
    const slice = text.slice(from, from + limit);
    const brk = CLAUSE_BREAK.exec(slice);
    return brk ? slice.slice(0, brk.index) : slice;
}

function clauseBefore(text: string, end: number, limit: number): string {
    const slice = text.slice(Math.max(0, end - limit), end);
    let last = -1;
    for (const m of slice.matchAll(new RegExp(CLAUSE_BREAK.source, "gi"))) {
        last = (m.index ?? 0) + m[0].length;
    }
    return last >= 0 ? slice.slice(last) : slice;
}

function aacRestrictedAsConsequence(output: string): boolean {
    for (const m of output.matchAll(new RegExp(AAC_TERM.source, "gi"))) {
        const start = m.index ?? 0;
        const before = clauseBefore(output, start, AAC_WINDOW_BEFORE);
        const after = clauseAfter(output, start, AAC_WINDOW_AFTER);
        const from = start - before.length;
        const window = before + after;
        const verb = RESTRICT_VERB.exec(window);
        if (!verb) continue;
        const absolute = from + (verb.index ?? 0);
        const lookback = output.slice(Math.max(0, absolute - NEGATION_LOOKBACK), absolute);
        if (NEGATOR.test(lookback)) continue;   // "AAC access is never removed"
        return true;
    }
    return false;
}

/** Characters of real prose required near a section marker for it to count. */
const SECTION_CONTENT_CHARS = 30;
const SECTION_WINDOW = 400;

/** Drop whole heading lines. Stripping only the `#` turns the NEXT heading into
 *  prose, which is why ten empty headings first scored 8 of 10. */
function proseOnly(text: string): string {
    return text
        .split("\n")
        .filter(line => !/^\s*#{1,6}\s/.test(line))          // markdown headings
        .filter(line => !/^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(line)) // bold-only lines
        .join(" ")
        .replace(/[>#*_|]+/g, "")
        .replace(/\[[^\]]*\]/g, "")                          // [placeholders]
        .replace(/[-\s]+/g, " ")
        .trim();
}

/**
 * A section counts only when there is real prose NEAR its marker.
 *
 * Without this, ten empty headings scored 8 of 10: an output with no clinical
 * content looked nearly complete, because the census matched vocabulary rather
 * than substance. The scaffold already demands "substantive content rather than
 * a heading alone"; this is the census checking the same thing.
 *
 * The window spans both directions. A first version looked only forward and
 * dropped a legitimate credit — "we will write down how often it happens on a
 * data sheet" puts the content BEFORE the keyword.
 *
 * Two limits, both measured rather than assumed.
 *
 * The window is wide, so in a dense document a marker finds prose belonging to
 * a NEIGHBOURING section and is credited for it. This is therefore closer to a
 * document-level check than a per-section one; what it reliably catches is the
 * empty or near-empty output, which is what it was added for.
 *
 * And a model that echoes the section list back as prose still scores full
 * marks, because a description of what a plan must contain is, at this level of
 * analysis, indistinguishable from a plan. That is a limit of the approach, not
 * something to regex away, and one more reason nothing here is an endorsement.
 *
 * The floor is deliberately low. At 50 characters a legitimately terse section
 * — "Frequency count / Daily tally / Weekly IOA" — was refused, and a false
 * negative on real content is the more expensive error for a gap report.
 */
function sectionHasContent(output: string, pattern: RegExp): boolean {
    const m = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(output);
    if (!m) return false;
    const at = m.index ?? 0;
    const window = output.slice(Math.max(0, at - SECTION_WINDOW), at + m[0].length + SECTION_WINDOW);
    return proseOnly(window).length >= SECTION_CONTENT_CHARS;
}

/**
 * Raise-only structural check. `pass: true` means nothing was detected as
 * missing — it is not a clinical endorsement.
 */
export function passesClinicalQualityGate(
    prompt: string,
    output: string,
): ClinicalQualityResult {
    // An operational-definition request is clinical on its own: "write an
    // operational definition of elopement" names no ABA vocabulary the broad
    // pattern looks for, and was silently skipped before.
    const clinicalContext =
        CLINICAL_CONTEXT_RE.test(prompt)
        || CLINICAL_PLAN_REQUEST_RE.test(prompt)
        || OPERATIONAL_DEFINITION_REQUEST_RE.test(prompt);
    if (!clinicalContext) return { pass: true };

    if (aacRestrictedAsConsequence(output)) {
        return { pass: false, reason: "clinical_aac_restricted_as_consequence" };
    }

    if (OPERATIONAL_DEFINITION_REQUEST_RE.test(prompt)) {
        const hasExamples = /\bexamples?\b/i.test(output);
        const hasNonExamples = /\bnon-?examples?\b/i.test(output);
        if (!hasExamples || !hasNonExamples) {
            return { pass: false, reason: "clinical_operational_definition_incomplete" };
        }
    }

    if (!CLINICAL_PLAN_REQUEST_RE.test(prompt)) return { pass: true };

    const missing = PLAN_SECTIONS
        .filter(s => !sectionHasContent(output, s.pattern))
        .map(s => s.name);
    const sections: ClinicalSectionReport = {
        required: PLAN_SECTIONS.length,
        present: PLAN_SECTIONS.length - missing.length,
        missing,
    };

    // An incomplete plan REPORTS; it does not fail. Failing the gate rejects the
    // output, and when escalation is unavailable the caller receives nothing at
    // all — measured in review: a 3-of-10 plan with cloud_fallback:true and an
    // unreachable portal returned "no backend produced output". A draft labelled
    // `clinical_sections=3/10 missing:...` is strictly more useful to a clinician
    // than silence, and suppressing it contradicts the raise-only rule above.
    //
    // The two findings ABOVE do fail, because they are defects rather than
    // incompleteness: AAC restricted as a consequence is a safety violation, and
    // an operational definition without non-examples is wrong, not unfinished.
    return { pass: true, sections };
}

/** Compact, raise-only header fragment. Counts only — never a verdict word. */
export function formatClinicalSections(s: ClinicalSectionReport): string {
    const base = `clinical_sections=${s.present}/${s.required}`;
    return s.missing.length ? `${base} missing:${s.missing.join(",")}` : base;
}

/**
 * A system instruction naming every section a plan must contain, generated from
 * PLAN_SECTIONS so the list that INSTRUCTS is the list that VERIFIES.
 *
 * Measured on prism-coder:9b: the same plan request scored 7/10 unscaffolded and
 * 10/10 scaffolded, in FEWER characters — it restructured rather than padded,
 * and the previously absent sections came back with substantive content
 * (a real observable definition with non-examples, real generalisation content,
 * a correctly worded review statement).
 *
 * KNOWN EPISTEMIC COST, recorded rather than hidden: once the model is told the
 * list, the census stops being independent confirmation and becomes a check
 * that the instruction was followed. A scaffolded 10/10 is weaker evidence than
 * an unscaffolded one. Sharing one list is still the right trade — two lists
 * drift, and a census that disagrees with the instruction is worse than a
 * census that merely confirms it — but nothing here should be read as evidence
 * that the model knows what a plan needs.
 *
 * LOCAL ONLY. `callCloud` takes the prompt and no system argument, so nothing
 * here reaches an escalated request — true of VISION_SYSTEM_PROMPT as well, and
 * pre-existing rather than introduced with this scaffold. The consequence is
 * that a cloud-served plan is measured by the census WITHOUT having been given
 * the list, so it can score lower than a local one for reasons that have
 * nothing to do with the model. Threading `system` through the portal API is
 * the real fix and is deliberately out of scope here.
 *
 * Returns undefined unless a full plan was requested, so it never touches the
 * prompt for ordinary work.
 */
export function clinicalPlanScaffold(prompt: string): string | undefined {
    if (!CLINICAL_PLAN_REQUEST_RE.test(prompt)) return undefined;
    const items = PLAN_SECTIONS.map(s => `- ${s.requirement}`).join("\n");
    return (
        "A behaviour plan must contain all of the following, each with substantive "
        + "content rather than a heading alone:\n" + items
        + "\n\nUse least restrictive, dignity-preserving, function-based procedures. "
        + "Never restrict, remove or delay access to an AAC or communication device "
        + "as a consequence."
    );
}
