import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PolicyGateway, ActionRoute } from '../../src/sdm/policyGateway.js';
import { HdcStateMachine } from '../../src/sdm/stateMachine.js';
import { ConceptDictionary } from '../../src/sdm/conceptDictionary.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { SparseDistributedMemory } from '../../src/sdm/sdmEngine.js';
import * as fixtures from '../helpers/fixtures.js';

describe('Intent Arbitration & Action Policy Gateway', () => {
  let dbParams: any;
  let dict: ConceptDictionary;
  let sdm: SparseDistributedMemory;
  let gateway: PolicyGateway;

  beforeEach(async () => {
    dbParams = await fixtures.createTestDb('policy-test');
    dict = new ConceptDictionary(dbParams.storage);
    sdm = new SparseDistributedMemory(9001);
    gateway = new PolicyGateway(dict); // Default 0.85 and 0.95
  });

  afterEach(async () => {
    await dbParams.storage.close();
    dbParams.cleanup();
  });

  it('routes to ACTION_AUTO_ROUTE for high confidence exact matches', async () => {
    // 1. Plant an intent
    const targetState = await dict.getConcept('Intent.Ping');
    for (let i = 0; i < 5; i++) {
      sdm.writeHdc(targetState, 45); // Solid kanerva basin
    }
    
    // 2. Start machine directly on the exact intent
    const machine = new HdcStateMachine(targetState, sdm);
    const result = await gateway.evaluateIntent(machine);

    expect(result.route).toBe(ActionRoute.ACTION_AUTO_ROUTE);
    expect(result.concept).toBe('Intent.Ping');
    expect(result.confidence).toBeGreaterThan(0.95);
    expect(result.ambiguous).toBe(false);
  });

  it('routes to ACTION_CLARIFY for mid-confidence boundaries', async () => {
    // Setup machine mock that returns specific fixed objects
    // It's easier and perfectly accurate to mock the inner state machine 
    // resolving specific values back so we test the Pure Gateway logic precisely.
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.Update',
      distance: 61,        // ~ 1 - 61/768 = ~0.92
      confidence: 0.920,   // Just above fallback (0.85), below auto (0.95)
      ambiguous: false,
      steps: 2
    });

    const result = await gateway.evaluateIntent(machineMock);
    
    expect(result.route).toBe(ActionRoute.ACTION_CLARIFY);
    expect(result.confidence).toBe(0.920);
  });

  it('routes to ACTION_CLARIFY when confidence >= 0.95 BUT ambiguous is true', async () => {
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.Ambiguous',
      distance: 2,         // High precision
      confidence: 0.999,   // Above threshold
      ambiguous: true,     // Margin is dangerously tight
      steps: 0
    });

    const result = await gateway.evaluateIntent(machineMock);
    // Despite 99.9% confidence to *a* concept, ambiguity overrides routing to CLARIFY
    expect(result.route).toBe(ActionRoute.ACTION_CLARIFY);
  });

  it('routes to ACTION_FALLBACK when confidence < 0.85 threshold', async () => {
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.RandomNoise',
      distance: 300,       // Distance > 256 indicates no correlation
      confidence: 0.609,   // Below 0.85
      ambiguous: true,
      steps: 10
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_FALLBACK);
  });

  it('routes to ACTION_FALLBACK when concept is strictly null', async () => {
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: null,
      distance: 700,
      confidence: 0.08,
      ambiguous: false,    // nothing to be ambiguous against
      steps: 3
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_FALLBACK);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES: Constructor guards & threshold boundary routing
// ═══════════════════════════════════════════════════════════════════

describe('PolicyGateway — Constructor Threshold Validation', () => {
  let dbParams: any;

  beforeEach(async () => {
    dbParams = await fixtures.createTestDb('policy-guard-test');
  });

  afterEach(async () => {
    await dbParams.storage.close();
    dbParams.cleanup();
  });

  it('throws when fallbackThreshold is negative', () => {
    /**
     * WHY: policyGateway.ts line 39 enforces fallbackThreshold >= 0.
     * A negative fallback would mean literally everything auto-routes,
     * defeating the safety net entirely.
     */
    const dict = new ConceptDictionary(dbParams.storage);
    expect(() => new PolicyGateway(dict, { fallbackThreshold: -0.1, clarifyThreshold: 0.95 }))
      .toThrow(/Invalid threshold/i);
  });

  it('throws when fallbackThreshold >= clarifyThreshold', () => {
    /**
     * WHY: policyGateway.ts line 40 enforces fallback < clarify.
     * If fallback >= clarify, the CLARIFY zone has zero width and
     * no intent can ever land there — rendering the tier useless.
     */
    const dict = new ConceptDictionary(dbParams.storage);
    expect(() => new PolicyGateway(dict, { fallbackThreshold: 0.95, clarifyThreshold: 0.95 }))
      .toThrow(/Invalid threshold/i);
  });

  it('throws when fallbackThreshold > clarifyThreshold (inverted)', () => {
    const dict = new ConceptDictionary(dbParams.storage);
    expect(() => new PolicyGateway(dict, { fallbackThreshold: 0.99, clarifyThreshold: 0.50 }))
      .toThrow(/Invalid threshold/i);
  });

  it('throws when clarifyThreshold > 1', () => {
    /**
     * WHY: policyGateway.ts line 41 enforces clarifyThreshold <= 1.
     * Confidence is capped at 1.0 (0 hamming distance = 100% match).
     * A threshold > 1 would make AUTO_ROUTE unreachable.
     */
    const dict = new ConceptDictionary(dbParams.storage);
    expect(() => new PolicyGateway(dict, { fallbackThreshold: 0.50, clarifyThreshold: 1.01 }))
      .toThrow(/Invalid threshold/i);
  });

  it('accepts valid thresholds: fallback=0, clarify=1 (extreme range)', () => {
    /**
     * WHY: fallback=0 and clarify=1 are boundary-valid.
     * fallback=0 means only null concepts fall back.
     * clarify=1 means only perfect matches auto-route.
     */
    const dict = new ConceptDictionary(dbParams.storage);
    expect(() => new PolicyGateway(dict, { fallbackThreshold: 0, clarifyThreshold: 1 }))
      .not.toThrow();
  });

  it('accepts defaults (no config) without throwing', () => {
    const dict = new ConceptDictionary(dbParams.storage);
    expect(() => new PolicyGateway(dict)).not.toThrow();
  });
});

describe('PolicyGateway — Exact Threshold Boundary Routing', () => {
  let dbParams: any;
  let dict: ConceptDictionary;

  beforeEach(async () => {
    dbParams = await fixtures.createTestDb('policy-boundary-test');
    dict = new ConceptDictionary(dbParams.storage);
  });

  afterEach(async () => {
    await dbParams.storage.close();
    dbParams.cleanup();
  });

  it('confidence exactly AT fallbackThreshold (0.85) → CLARIFY, not FALLBACK', async () => {
    /**
     * WHY: policyGateway.ts line 60 uses `confidence < fallbackThreshold`.
     * The strict-less-than means 0.85 is NOT below threshold, so it
     * falls through to the CLARIFY check. This is the critical off-by-one
     * boundary that could silently misroute if changed to <=.
     */
    const gateway = new PolicyGateway(dict); // default 0.85 / 0.95
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.Boundary', distance: 115, confidence: 0.85,
      ambiguous: false, steps: 1
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_CLARIFY);
  });

  it('confidence exactly AT clarifyThreshold (0.95) → AUTO_ROUTE, not CLARIFY', async () => {
    /**
     * WHY: policyGateway.ts line 62 uses `confidence < clarifyThreshold`.
     * confidence=0.95 is NOT below 0.95, so it falls through to AUTO_ROUTE.
     */
    const gateway = new PolicyGateway(dict);
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.Precise', distance: 38, confidence: 0.95,
      ambiguous: false, steps: 1
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_AUTO_ROUTE);
  });

  it('confidence just below fallbackThreshold (0.8499) → FALLBACK', async () => {
    const gateway = new PolicyGateway(dict);
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.AlmostThere', distance: 116, confidence: 0.8499,
      ambiguous: false, steps: 2
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_FALLBACK);
  });

  it('confidence just below clarifyThreshold (0.9499) → CLARIFY', async () => {
    const gateway = new PolicyGateway(dict);
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.Close', distance: 39, confidence: 0.9499,
      ambiguous: false, steps: 1
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_CLARIFY);
  });

  it('null concept overrides high confidence → always FALLBACK', async () => {
    /**
     * WHY: policyGateway.ts line 60 checks `concept === null` first.
     * Even if confidence were 1.0, a null concept means the dictionary
     * had zero entries. This must ALWAYS route to FALLBACK.
     */
    const gateway = new PolicyGateway(dict);
    const machineMock = Object.create(HdcStateMachine.prototype);
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: null, distance: 0, confidence: 1.0,
      ambiguous: false, steps: 1
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_FALLBACK);
  });

  it('custom thresholds pass through correctly', async () => {
    /**
     * WHY: Verifies that non-default threshold values are actually
     * used in routing, not silently overridden by defaults.
     */
    const gateway = new PolicyGateway(dict, {
      fallbackThreshold: 0.50,
      clarifyThreshold: 0.80
    });
    const machineMock = Object.create(HdcStateMachine.prototype);
    // confidence=0.75: above 0.50 (not fallback), below 0.80 (clarify)
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.Custom', distance: 192, confidence: 0.75,
      ambiguous: false, steps: 1
    });

    const result = await gateway.evaluateIntent(machineMock);
    expect(result.route).toBe(ActionRoute.ACTION_CLARIFY);

    // confidence=0.80: exactly at clarify threshold → AUTO_ROUTE
    machineMock.recallToConcept = vi.fn().mockResolvedValue({
      concept: 'Intent.Custom', distance: 154, confidence: 0.80,
      ambiguous: false, steps: 1
    });

    const result2 = await gateway.evaluateIntent(machineMock);
    expect(result2.route).toBe(ActionRoute.ACTION_AUTO_ROUTE);
  });
});
