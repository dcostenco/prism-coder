import { HDCEngine } from './hdc.js';
import { SparseDistributedMemory, D_ADDR_UINT32 } from './sdmEngine.js';

export class HdcStateMachine {
  private currentState: Uint32Array;
  private sdm: SparseDistributedMemory;

  constructor(initialState: Uint32Array, sdm: SparseDistributedMemory) {
    if (initialState.length !== D_ADDR_UINT32) {
      throw new Error(`[HdcStateMachine] initialState must be exactly ${D_ADDR_UINT32} words, got ${initialState.length}`);
    }
    // Clone the initial state to ensure immutability of the source concept
    this.currentState = new Uint32Array(initialState);
    this.sdm = sdm;
  }

  /**
   * Transition the state machine using a new role and action vector.
   * Formula: S_{t+1} = BUNDLE([PERMUTE(S_t), BIND(Role_t, Action_t)])
   *
   * @param roleVector The HDC vector representing the role
   * @param actionVector The HDC vector representing the action
   * @returns The newly computed continuous state vector
   */
  transition(roleVector: Uint32Array, actionVector: Uint32Array): Uint32Array {
    if (roleVector.length !== D_ADDR_UINT32 || actionVector.length !== D_ADDR_UINT32) {
      throw new Error(`[HdcStateMachine] Vectors must be exactly ${D_ADDR_UINT32} words`);
    }

    const permutedState = HDCEngine.permute(this.currentState);
    const boundAction = HDCEngine.bind(roleVector, actionVector);

    // BUNDLE([PERMUTE(S_t), BIND(Role_t, Action_t)])
    this.currentState = HDCEngine.bundle([permutedState, boundAction]);

    return new Uint32Array(this.currentState);
  }

  static bundleHistory(states: Uint32Array[]): Uint32Array {
    return HDCEngine.bundle(states);
  }

  recall(): Uint32Array {
    return this.sdm.readHdc(this.currentState);
  }

  /**
   * Performs an iterative SDM context cleanup to converge on an attractor state,
   * then matches that state against known symbolic concepts in the dictionary.
   */
  async recallToConcept(
    dict: import('./conceptDictionary.js').ConceptDictionary,
    opts?: {
      maxDistance?: number;
      maxResults?: number;
      minMargin?: number;
      maxIterations?: number; // default: 5
    }
  ): Promise<{
    concept: string | null;
    distance: number;
    confidence: number;
    steps: number;
    ambiguous: boolean;
  }> {
    const maxIterations = opts?.maxIterations ?? 5;
    
    // 1. Iterative Kanerva projection cleanup
    let currentStateCopy = new Uint32Array(this.currentState);
    let convergedBase = this.sdm.readHdc(currentStateCopy);
    let steps = 1;

    // Fast Hamming inline to avoid importing since it's simple or we could import it.
    const hDist = (a: Uint32Array, b: Uint32Array) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) {
        let x = a[i] ^ b[i];
        while (x) { d++; x &= x - 1; }
      }
      return d;
    };

    for (; steps < maxIterations; steps++) {
      const nextState = this.sdm.readHdc(convergedBase);
      if (hDist(convergedBase, nextState) === 0) {
        break;
      }
      convergedBase = nextState;
    }

    // 2. Nearest neighbor structural bridge
    const resolved = await dict.nearestConcept(convergedBase, opts);

    if (resolved.winner) {
      return {
        concept: resolved.winner.concept,
        distance: resolved.winner.distance,
        confidence: resolved.winner.confidence,
        steps,
        ambiguous: resolved.ambiguous
      };
    }

    return {
      concept: null,
      distance: resolved.candidates[0]?.distance ?? 768,
      confidence: resolved.candidates[0]?.confidence ?? 0,
      steps,
      ambiguous: resolved.ambiguous
    };
  }

  getCurrentState(): Uint32Array {
    return new Uint32Array(this.currentState);
  }
  
  injectStateForTesting(state: Uint32Array): void {
     if (state.length !== D_ADDR_UINT32) throw new Error("Invalid testing state dimension");
     this.currentState = new Uint32Array(state);
  }
}
