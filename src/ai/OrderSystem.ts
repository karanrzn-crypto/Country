import type { EventBus } from '../events/EventBus';
import type { EntityRegistry } from '../entities/EntityRegistry';
import type { EntityId } from '../core/IdGenerator';
import type { OrderRecord } from './types';

/**
 * Order pipeline: strategies become orders; executors (Phase 2+) consume
 * them. Orders are runtime-only for now (not persisted) — persistence lands
 * together with order executors.
 */
export class OrderSystem {
  constructor(
    private readonly orders: EntityRegistry<OrderRecord>,
    private readonly events: EventBus,
    private readonly ids: { next(kind: string): EntityId }
  ) {}

  issue(
    factionId: string,
    action: string,
    params: Readonly<Record<string, number | string>>,
    priority: number,
    issuedTick: number
  ): OrderRecord {
    const order: OrderRecord = {
      id: this.ids.next('order'),
      kind: 'order',
      factionId,
      action,
      params,
      priority,
      issuedTick,
      status: 'pending'
    };
    this.orders.add(order);
    this.events.emit('ai.orderIssued', {
      orderId: order.id,
      factionId,
      action,
      priority
    });
    return order;
  }

  pendingFor(factionId: string): OrderRecord[] {
    const result: OrderRecord[] = [];
    for (const order of this.orders.values()) {
      if (order.factionId === factionId && order.status === 'pending') result.push(order);
    }
    return result.sort((a, b) => b.priority - a.priority);
  }

  complete(orderId: EntityId): void {
    const order = this.orders.get(orderId);
    if (order !== undefined) order.status = 'completed';
  }

  get size(): number {
    return this.orders.size;
  }
}
