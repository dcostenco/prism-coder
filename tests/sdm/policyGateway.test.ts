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
