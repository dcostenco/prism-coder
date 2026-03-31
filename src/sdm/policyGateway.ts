import { ConceptDictionary } from './conceptDictionary.js';
import { HdcStateMachine } from './stateMachine.js';
import { debugLog } from '../utils/logger.js';

export enum ActionRoute {
  ACTION_AUTO_ROUTE = 'ACTION_AUTO_ROUTE',
  ACTION_CLARIFY = 'ACTION_CLARIFY',
  ACTION_FALLBACK = 'ACTION_FALLBACK'
}

export interface IntentEvaluationResult {
  route: ActionRoute;
  concept: string | null;
  confidence: number;
  distance: number;
  ambiguous: boolean;
  steps: number;
}

export interface IntentPolicyConfig {
  fallbackThreshold: number; // e.g. 0.85
  clarifyThreshold: number;  // e.g. 0.95
}

const DEFAULT_POLICY: IntentPolicyConfig = {
  fallbackThreshold: 0.85,
  clarifyThreshold: 0.95
};

export class PolicyGateway {
  private dict: ConceptDictionary;
  private config: IntentPolicyConfig;

  constructor(dict: ConceptDictionary, config: Partial<IntentPolicyConfig> = {}) {
    this.dict = dict;
    this.config = { ...DEFAULT_POLICY, ...config };

    if (
      this.config.fallbackThreshold < 0 ||
      this.config.fallbackThreshold >= this.config.clarifyThreshold ||
      this.config.clarifyThreshold > 1
    ) {
      throw new Error(`[PolicyGateway] Invalid threshold configuration. Must satisfy 0 <= fallback < clarify <= 1. Received: ${JSON.stringify(this.config)}`);
    }
  }

  /**
   * Evaluates the current state of the HDC state machine, projects it onto the closest legal semantic concept,
   * calculates confidence and ambiguity, and applies the configured routing policy.
   * 
   * Also emits a structured telemetry trace into `debugLog`.
   */
  async evaluateIntent(machine: HdcStateMachine): Promise<IntentEvaluationResult> {
    // 1. Hook into the semantic bridge
    const resolution = await machine.recallToConcept(this.dict);

    // 2. Policy Threshold Routing
    let route: ActionRoute;

    if (resolution.concept === null || resolution.confidence < this.config.fallbackThreshold) {
      route = ActionRoute.ACTION_FALLBACK;
    } else if (resolution.ambiguous || resolution.confidence < this.config.clarifyThreshold) {
      route = ActionRoute.ACTION_CLARIFY;
    } else {
      route = ActionRoute.ACTION_AUTO_ROUTE;
    }

    // 3. Telemetry Logging
    // We log structured JSON to debugLog for easy scraping/calibration later.
    const telemetry = {
      event: 'intent_resolved',
      route,
      concept: resolution.concept,
      confidence: resolution.confidence,
      distance: resolution.distance,
      ambiguous: resolution.ambiguous,
      steps: resolution.steps,
      unknown_intent: resolution.concept === null,
      thresholds: {
        fallback: this.config.fallbackThreshold,
        clarify: this.config.clarifyThreshold
      }
    };
    
    debugLog(`[PolicyGateway] ${JSON.stringify(telemetry)}`);

    return {
      route,
      concept: resolution.concept,
      confidence: resolution.confidence,
      distance: resolution.distance,
      ambiguous: resolution.ambiguous,
      steps: resolution.steps
    };
  }
}
