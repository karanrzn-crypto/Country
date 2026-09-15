import { describe, it, expect } from 'vitest';
import { DecisionSystem } from '../../../ai/DecisionSystem';
import { StrategyRegistry } from '../../../ai/StrategyRegistry';
import { evaluateCondition, evaluateAll } from '../../../ai/ConditionEvaluator';
import { createTestGame } from '../../helpers/testGame';
import type { AIStrategyDef } from '../../../ai/types';

const OFFENSIVE: AIStrategyDef = {
  id: 'offensive',
  name: 'Offensive',
  kind: 'strategic',
  priority: 70,
  conditions: [
    { metric: 'strength_ratio', op: '>=', value: 1.3 },
    { metric: 'supply_ratio', op: '>=', value: 0.6 }
  ],
  tags: []
};

const CONSOLIDATE: AIStrategyDef = {
  id: 'consolidate',
  name: 'Consolidate',
  kind: 'strategic',
  priority: 20,
  conditions: [],
  tags: []
};

const WITHDRAWAL: AIStrategyDef = {
  id: 'defensive_withdrawal',
  name: 'Defensive Withdrawal',
  kind: 'strategic',
  priority: 60,
  conditions: [
    { metric: 'strength_ratio', op: '<', value: 0.7 },
    { metric: 'under_threat', op: '==', value: 1 }
  ],
  tags: []
};

describe('ConditionEvaluator', () => {
  it('supports all comparison operators', () => {
    const metrics = { x: 5 };
    expect(evaluateCondition({ metric: 'x', op: '>', value: 4 }, metrics)).toBe(true);
    expect(evaluateCondition({ metric: 'x', op: '>=', value: 5 }, metrics)).toBe(true);
    expect(evaluateCondition({ metric: 'x', op: '<', value: 10 }, metrics)).toBe(true);
    expect(evaluateCondition({ metric: 'x', op: '<=', value: 4 }, metrics)).toBe(false);
    expect(evaluateCondition({ metric: 'x', op: '==', value: 5 }, metrics)).toBe(true);
    expect(evaluateCondition({ metric: 'x', op: '!=', value: 5 }, metrics)).toBe(false);
  });

  it('fails closed on unknown metrics', () => {
    expect(evaluateCondition({ metric: 'missing', op: '>', value: 0 }, {})).toBe(false);
  });

  it('evaluateAll requires every condition', () => {
    expect(evaluateAll([{ metric: 'x', op: '>', value: 0 }, { metric: 'y', op: '>', value: 0 }], { x: 1, y: 1 })).toBe(true);
    expect(evaluateAll([{ metric: 'x', op: '>', value: 0 }, { metric: 'y', op: '>', value: 0 }], { x: 1, y: 0 })).toBe(false);
  });
});

describe('DecisionSystem (data-driven strategy selection)', () => {
  it('picks the highest-priority passing strategy', () => {
    const registry = new StrategyRegistry();
    registry.registerAll([CONSOLIDATE, OFFENSIVE, WITHDRAWAL]);
    const decision = new DecisionSystem(registry);

    const strong = decision.select({ strength_ratio: 2, supply_ratio: 1, under_threat: 0 });
    expect(strong?.strategyId).toBe('offensive');

    const weak = decision.select({ strength_ratio: 0.5, supply_ratio: 1, under_threat: 1 });
    expect(weak?.strategyId).toBe('defensive_withdrawal');

    const neutral = decision.select({ strength_ratio: 1, supply_ratio: 0.5, under_threat: 0 });
    expect(neutral?.strategyId).toBe('consolidate');
  });

  it('empty conditions always pass (fallback strategy)', () => {
    const registry = new StrategyRegistry();
    registry.registerAll([CONSOLIDATE]);
    const decision = new DecisionSystem(registry);
    expect(decision.select({})?.strategyId).toBe('consolidate');
  });

  it('breaks priority ties deterministically by id', () => {
    const registry = new StrategyRegistry();
    registry.registerAll([
      { ...CONSOLIDATE, id: 'bravo' },
      { ...CONSOLIDATE, id: 'alpha' }
    ]);
    const decision = new DecisionSystem(registry);
    expect(decision.select({})?.strategyId).toBe('alpha');
  });
});

describe('AIManager integration', () => {
  it('creates agents for every non-player country and selects data strategies', () => {
    const game = createTestGame({ seed: 11, configOverrides: { ai: { decisionIntervalTicks: 2 } } });
    const agents = game.ai.agentList;
    expect(agents).toHaveLength(1); // 2 countries − player
    expect(agents[0].factionId).toBe('neighbor');

    game.runTicks(20);
    expect(agents[0].currentStrategyId).not.toBeNull();
    // Strategy must be one declared in strategies.json.
    expect(game.ai.strategyRegistry.size).toBe(8);
    game.dispose();
  });

  it('issues orders on the decision interval and emits events', () => {
    const game = createTestGame({ seed: 11, configOverrides: { ai: { decisionIntervalTicks: 2 } } });
    const strategies: string[] = [];
    const orders: string[] = [];
    game.gameEvents.on('ai.strategySelected', ({ strategyId }) => strategies.push(strategyId));
    game.gameEvents.on('ai.orderIssued', ({ action }) => orders.push(action));
    game.runTicks(10);
    expect(strategies.length).toBeGreaterThan(0);
    expect(orders.length).toBeGreaterThan(0);
    game.dispose();
  });

  it('can be disabled via toggle', () => {
    const game = createTestGame({ seed: 11, configOverrides: { ai: { decisionIntervalTicks: 2 } } });
    game.toggleAI();
    expect(game.ai.isEnabled).toBe(false);
    game.runTicks(10);
    expect(game.ai.agentList[0].currentStrategyId).toBeNull();
    game.dispose();
  });
});
