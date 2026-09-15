import type { SystemContext } from '../core/GameContext';
import type { PhaseSystem, SystemUpdate } from '../core/SystemTypes';
import type { EntityId } from '../core/IdGenerator';
import type { EventBus } from '../events/EventBus';
import { EntityRegistry } from '../entities/EntityRegistry';
import { StrategyRegistry } from './StrategyRegistry';
import { DecisionSystem } from './DecisionSystem';
import { GoalSystem } from './GoalSystem';
import { OrderSystem } from './OrderSystem';
import { computeFactionMetrics } from './MetricProvider';
import type { AIStrategyDef, BehaviorState, Goal, OrderRecord } from './types';
export interface AIAgent {
  readonly id: EntityId;
  readonly kind: 'agent';
  readonly factionId: string;
  behavior: BehaviorState;
  goals: Goal[];
  currentStrategyId: string | null;
  lastDecisionTick: number;
}

/**
 * AI foundation — Phase 0 scope.
 *
 * Owns agents (one per non-player country), refreshes decision metrics and
 * runs the decision loop on a fixed interval: goals → strategy selection →
 * order issue. Strategies are pure data (strategies.json); the framework
 * ships no hard-coded AI behavior beyond the loop itself.
 *
 * Strategic/Tactical/Pathfinding interfaces are declared extension points:
 * later phases plug real executors under the same manager without rewiring.
 */
export class AIManager implements PhaseSystem {
  readonly id = 'core.ai';
  readonly phase = 'ai' as const;

  private readonly agents = new EntityRegistry<AIAgent>();
  private readonly strategies = new StrategyRegistry();
  private readonly orders = new EntityRegistry<OrderRecord>();
  private readonly goalSystem = new GoalSystem();
  private decisionSystem!: DecisionSystem;
  private orderSystem!: OrderSystem;
  private enabled = true;

  constructor(
    private readonly events: EventBus,
    private readonly ids: { next(kind: string): EntityId }
  ) {}

  init(context: SystemContext): void {
    this.decisionSystem = new DecisionSystem(this.strategies);
    this.orderSystem = new OrderSystem(this.orders, this.events, this.ids);
    this.strategies.registerAll(context.data.strategyList);

    for (const countryId of Object.keys(context.state.world.countries)) {
      if (countryId === context.state.player.countryId) continue;
      this.agents.add({
        id: this.ids.next('agent'),
        kind: 'agent',
        factionId: countryId,
        behavior: 'idle',
        goals: [],
        currentStrategyId: null,
        lastDecisionTick: 0
      });
    }

    context.logger.child('ai').info(`AI initialized: ${this.agents.size} agent(s), ${this.strategies.size} strategies`);
  }

  update(context: SystemContext, update: SystemUpdate): void {
    if (update.kind !== 'tick' || !this.enabled) return;
    const interval = context.config.ai.decisionIntervalTicks;
    if (update.tick.tick % interval !== 0) return;

    for (const agent of this.agents.values()) {
      const metrics = computeFactionMetrics(context.state, agent.factionId);
      const decision = this.decisionSystem.select(metrics);
      if (decision !== null && decision.strategyId !== agent.currentStrategyId) {
        agent.currentStrategyId = decision.strategyId;
        agent.behavior = 'executing';
        this.events.emit('ai.strategySelected', {
          agentId: agent.id,
          factionId: agent.factionId,
          strategyId: decision.strategyId,
          score: decision.score
        });
      }

      // Standing orders per selected strategy (executors arrive in Phase 2).
      if (agent.currentStrategyId !== null && update.tick.tick - agent.lastDecisionTick >= interval) {
        const strategy = this.strategies.get(agent.currentStrategyId);
        this.orderSystem.issue(
          agent.factionId,
          `execute_strategy:${strategy.id}`,
          {},
          strategy.priority,
          update.tick.tick
        );
        agent.lastDecisionTick = update.tick.tick;
      }
    }
  }

  // —— extension points for later phases ——

  get agentList(): readonly AIAgent[] {
    return [...this.agents.values()];
  }

  agentFor(factionId: string): AIAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.factionId === factionId) return agent;
    }
    return undefined;
  }

  get strategyRegistry(): StrategyRegistry {
    return this.strategies;
  }

  get orderBus(): OrderSystem | undefined {
    return this.orderSystem;
  }

  get goals(): GoalSystem {
    return this.goalSystem;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  getStats(): Record<string, string | number> {
    return {
      agents: this.agents.size,
      strategies: this.strategies.size,
      orders: this.orders.size
    };
  }

  dispose(): void {
    this.agents.clear();
    this.orders.clear();
  }

  strategyOf(agent: AIAgent): AIStrategyDef | undefined {
    return agent.currentStrategyId !== null ? this.strategies.get(agent.currentStrategyId) : undefined;
  }
}
