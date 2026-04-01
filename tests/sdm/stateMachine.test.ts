import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HdcStateMachine } from '../../src/sdm/stateMachine.js';
import { ConceptDictionary, DeterministicPRNG } from '../../src/sdm/conceptDictionary.js';
import { SparseDistributedMemory, hammingDistance, D_ADDR_UINT32 } from '../../src/sdm/sdmEngine.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { createTestDb } from '../helpers/fixtures.js';

// Helper to randomly corrupt bits based on a probability ratio deterministically
function fuzzVector(vec: Uint32Array, flipRatio: number, seed: number = 1337): Uint32Array {
  const prng = new DeterministicPRNG(seed);
  const result = new Uint32Array(vec.length);
  const maxUint32 = 0xFFFFFFFF;
  for (let w = 0; w < vec.length; w++) {
    let word = vec[w];
    for (let bitIdx = 0; bitIdx < 32; bitIdx++) {
      // prng.nextUInt32() returns a uniform distribution 0 to maxUint32
      const randValue = prng.nextUInt32() / maxUint32;
      if (randValue < flipRatio) {
         word ^= (1 << bitIdx); // flip the bit
      }
    }
    result[w] = word >>> 0;
  }
  return result;
}

describe('HDC State Machine & Cognitive Logic', () => {
  let storage: SqliteStorage;
  let dict: ConceptDictionary;
  let sdm: SparseDistributedMemory;
  let cleanup: () => void;

  beforeEach(async () => {
    const db = await createTestDb("machine-test");
    storage = db.storage;
    cleanup = db.cleanup;
    
    dict = new ConceptDictionary(storage);
    sdm = new SparseDistributedMemory(42);
  });

  afterEach(async () => {
    await storage.close();
    cleanup();
  });

  it('1. Dictionary determinism: same concept => identical vector across restarts', async () => {
    const concept1 = await dict.getConcept('State:Idle');
    
    // Simulate process restart
    const newDb = await createTestDb("machine-test-restart");
    const newStorage = newDb.storage;
    const newDict = new ConceptDictionary(newStorage);
    
    const concept2 = await newDict.getConcept('State:Idle');
    
    // Validate determinism
    expect(hammingDistance(concept1, concept2)).toBe(0);
    await newStorage.close();
    newDb.cleanup();
  });

  it('2. Orthogonality distribution: pairwise distances centered near 384', async () => {
    const conceptA = await dict.getConcept('Concept:A');
    const conceptB = await dict.getConcept('Concept:B');
    const conceptC = await dict.getConcept('Concept:C');
    
    const distAB = hammingDistance(conceptA, conceptB);
    const distBC = hammingDistance(conceptB, conceptC);
    const distAC = hammingDistance(conceptA, conceptC);
    
    const validHamming = (d: number) => d > 320 && d < 448;
    
    expect(validHamming(distAB)).toBe(true);
    expect(validHamming(distBC)).toBe(true);
    expect(validHamming(distAC)).toBe(true);
  });

  it('3. Order test: verify A -> B !== B -> A with revised transition rule', async () => {
    const stateStart = await dict.getConcept('State:Start');
    
    const roleA = await dict.getConcept('Role:A');
    const actionA = await dict.getConcept('Action:A');
    
    const roleB = await dict.getConcept('Role:B');
    const actionB = await dict.getConcept('Action:B');
    
    // A then B
    const machine1 = new HdcStateMachine(stateStart, sdm);
    machine1.transition(roleA, actionA);
    const endState1 = machine1.transition(roleB, actionB);

    // B then A
    const machine2 = new HdcStateMachine(stateStart, sdm);
    machine2.transition(roleB, actionB);
    const endState2 = machine2.transition(roleA, actionA);

    // Sequence matters: the final states should be pseudo-orthogonal
    const dist = hammingDistance(endState1, endState2);
    expect(dist).toBeGreaterThan(100);
  });

  it('4. Mode isolation test: semantic call then HDC call on same instance throws', async () => {
    const isolatedSdm = new SparseDistributedMemory(101);
    
    // Use for semantic
    isolatedSdm.write(new Float32Array(768));
    
    // Identify a target
    const hdcState = await dict.getConcept('State:Any');
    
    let caughtError = false;
    let errorMessage = '';
    try {
        isolatedSdm.writeHdc(hdcState);
    } catch (e: any) {
        caughtError = true;
        errorMessage = e.message;
    }
    
    expect(caughtError).toBe(true);
    expect(errorMessage).toContain('Engine mode cross-talk violation');
  });

  it('5. Recall test: fuzz 15%, recover via readHdc, assert >=99% accuracy', async () => {
    const stateStart = await dict.getConcept('State:Start');
    const roleA = await dict.getConcept('Role:A');
    const actionA = await dict.getConcept('Action:A');
    
    const machine = new HdcStateMachine(stateStart, sdm);
    const exactTargetState = machine.transition(roleA, actionA);
    
    // Load state matrix
    for (let i = 0; i < 5; i++) {
        sdm.writeHdc(exactTargetState, 40);
    }

    // Fuzz exact target state by 15% 
    const noisyState = fuzzVector(exactTargetState, 0.15);
    const noiseDist = hammingDistance(exactTargetState, noisyState);
    expect(noiseDist).toBeGreaterThan(80);
    expect(noiseDist).toBeLessThan(150);
    
    // Mutate state with the fuzzed variance
    machine.injectStateForTesting(noisyState);
    
    // Associate Kanerva noise collapse (iterative convergence)
    let recalledState = machine.recall();
    for(let step = 0; step < 5; step++) {
       machine.injectStateForTesting(recalledState);
       const nextState = machine.recall();
       if (hammingDistance(recalledState, nextState) === 0) break;
       recalledState = nextState;
    }
    
    const finalDist = hammingDistance(exactTargetState, recalledState);
    
    // Assert at least 99% bit accuracy
    expect(finalDist).toBeLessThanOrEqual(7);
  });

  it('6. Concept bridge: resolve noisy HDC trace back to concept name', async () => {
    // 1. Get real dictionary concept and store inside tests dictionary DB
    const conceptName = 'USER_INTENT.BUG_FIX';
    const targetVector = await dict.getConcept(conceptName);
    
    // Write the concept into HDC SDM memory location for kanerva convergence
    for (let i = 0; i < 5; i++) {
        sdm.writeHdc(targetVector, 40);
    }

    // 2. Fuzz 15% noise
    const noisyState = fuzzVector(targetVector, 0.15, 777);
    
    // Inject and execute bridge
    const machine = new HdcStateMachine(targetVector, sdm);
    machine.injectStateForTesting(noisyState);
    const result = await machine.recallToConcept(dict);

    expect(result.concept).toBe(conceptName);
    expect(result.distance).toBeLessThan(7);
    expect(result.confidence).toBeGreaterThan(0.99);
    expect(result.steps).toBeGreaterThan(0);
    expect(result.ambiguous).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES: Constructor guards, dimension checks, defensive copies
// ═══════════════════════════════════════════════════════════════════

describe('HdcStateMachine — Edge Cases & Error Guards', () => {
  let storage: any;
  let sdm: SparseDistributedMemory;
  let cleanup: () => void;

  beforeEach(async () => {
    const db = await createTestDb("machine-edge-test");
    storage = db.storage;
    cleanup = db.cleanup;
    sdm = new SparseDistributedMemory(42);
  });

  afterEach(async () => {
    await storage.close();
    cleanup();
  });

  it('constructor throws on wrong-sized initialState', () => {
    /**
     * WHY: stateMachine.ts line 9-11 guards initialState.length !== D_ADDR_UINT32.
     * A wrong-sized vector would corrupt every subsequent transition
     * because XOR alignment would be mismatched.
     */
    const wrongSize = new Uint32Array(10); // D_ADDR_UINT32 = 24
    expect(() => new HdcStateMachine(wrongSize, sdm))
      .toThrow(/must be exactly/i);
  });

  it('constructor throws on empty vector', () => {
    const empty = new Uint32Array(0);
    expect(() => new HdcStateMachine(empty, sdm))
      .toThrow(/must be exactly/i);
  });

  it('transition() throws on wrong-sized role vector', () => {
    /**
     * WHY: stateMachine.ts line 26-28 guards vector dimensions.
     * Mismatched dimensions between state and role/action would
     * produce XOR over out-of-bounds memory (silent corruption).
     */
    const validState = new Uint32Array(D_ADDR_UINT32);
    const machine = new HdcStateMachine(validState, sdm);

    const wrongRole = new Uint32Array(12); // wrong dimension
    const validAction = new Uint32Array(D_ADDR_UINT32);

    expect(() => machine.transition(wrongRole, validAction))
      .toThrow(/must be exactly/i);
  });

  it('transition() throws on wrong-sized action vector', () => {
    const validState = new Uint32Array(D_ADDR_UINT32);
    const machine = new HdcStateMachine(validState, sdm);

    const validRole = new Uint32Array(D_ADDR_UINT32);
    const wrongAction = new Uint32Array(1);

    expect(() => machine.transition(validRole, wrongAction))
      .toThrow(/must be exactly/i);
  });

  it('getCurrentState() returns a defensive clone (not the internal reference)', () => {
    /**
     * WHY: stateMachine.ts line 108 returns `new Uint32Array(this.currentState)`.
     * If it returned the live internal array, external mutation would
     * corrupt the machine's state without going through transition().
     */
    const validState = new Uint32Array(D_ADDR_UINT32);
    validState[0] = 0xDEADBEEF;
    const machine = new HdcStateMachine(validState, sdm);

    const state1 = machine.getCurrentState();
    const state2 = machine.getCurrentState();

    // Same content
    expect(state1).toEqual(state2);
    // Different references — mutation of one must not affect the machine
    expect(state1).not.toBe(state2);
    state1[0] = 0;
    expect(machine.getCurrentState()[0]).toBe(0xDEADBEEF >>> 0);
  });

  it('injectStateForTesting() throws on wrong-dimension vector', () => {
    /**
     * WHY: stateMachine.ts line 112 guards dimension.
     * This testing-only API must not bypass safety checks.
     */
    const validState = new Uint32Array(D_ADDR_UINT32);
    const machine = new HdcStateMachine(validState, sdm);
    expect(() => machine.injectStateForTesting(new Uint32Array(5)))
      .toThrow(/Invalid testing state dimension/i);
  });

  it('constructor clones initial state (does not hold external reference)', () => {
    /**
     * WHY: stateMachine.ts line 13 clones via `new Uint32Array(initialState)`.
     * If the constructor held the external reference, mutation of the
     * original array after construction would corrupt the machine.
     */
    const initial = new Uint32Array(D_ADDR_UINT32);
    initial[0] = 0x12345678;
    const machine = new HdcStateMachine(initial, sdm);

    // Mutate the original AFTER construction
    initial[0] = 0;

    // Machine must retain the original value
    expect(machine.getCurrentState()[0]).toBe(0x12345678 >>> 0);
  });
});

