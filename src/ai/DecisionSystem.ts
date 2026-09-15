import type { AIStrategyDef } from './types';
import type { StrategyRegistry } from './StrategyRegistry';
import { evaluateAll } from './ConditionEvaluator';

export interface DecisionResult {
  readonly strategyId: string;
  readonly score: number;
}

/**
 * Selects the best strategy for an agent: among data-driven strategies whose
 * conditions pass, the highest priority wins. Ties break deterministically
 * by strategy id so replays stay stable.
 */
export class DecisionSystem {
  constructor(private readonly strategies: StrategyRegistry) {}

  select(metrics: Readonly<Record<string, number>>): DecisionResult | null {
    let best: DecisionResult | null = null;
    for (const strategy of this.strategies.byKind('strategic')) {
      if (!evaluateAll(strategy.conditions, metrics)) continue;
      if (best === null || strategy.priority > best.score) {
        best = { strategyId: strategy.id, score: strategy.priority };
      } else if (strategy.priority === best.score && strategy.id < best.strategyId) {
        best = { strategyId: strategy.id, score: strategy.priority };
      }
    }
    return best;
  }

  describe(strategyId: string): AIStrategyDef {
    return this.strategies.get(strategyId);
  }
}
