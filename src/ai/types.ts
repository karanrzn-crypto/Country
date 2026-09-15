/**
 * AI domain types: data-driven strategy definitions, conditions, goals,
 * orders and behavior states. Leaf module — no imports beyond core id types.
 */

import type { EntityId } from '../core/IdGenerator';

export type ConditionOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

export interface AICondition {
  readonly metric: string;
  readonly op: ConditionOp;
  readonly value: number;
}

/** Data-driven strategy (src/data/strategies.json). */
export interface AIStrategyDef {
  readonly id: string;
  readonly name: string;
  readonly kind: 'strategic' | 'tactical';
  readonly priority: number;
  readonly conditions: readonly AICondition[];
  readonly tags: readonly string[];
}

export type BehaviorState = 'idle' | 'executing' | 'regrouping' | 'withdrawing';

export interface Goal {
  readonly id: EntityId;
  readonly name: string;
  readonly priority: number;
  readonly status: 'pending' | 'active' | 'done' | 'failed';
}

export interface OrderRecord {
  readonly id: EntityId;
  readonly kind: 'order';
  readonly factionId: string;
  readonly action: string;
  readonly params: Readonly<Record<string, number | string>>;
  readonly priority: number;
  readonly issuedTick: number;
  status: 'pending' | 'acknowledged' | 'completed' | 'cancelled';
}
