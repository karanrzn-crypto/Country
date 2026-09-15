import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../events/EventBus';
import { Logger, MemoryLogSink } from '../../../utils/Logger';

describe('EventBus', () => {
  it('delivers typed payloads to subscribers', () => {
    const bus = new EventBus();
    const received: number[] = [];
    bus.on('game.speedChanged', ({ speed }) => received.push(speed));
    bus.emit('game.speedChanged', { speed: 2 });
    bus.emit('game.speedChanged', { speed: 4 });
    expect(received).toEqual([2, 4]);
  });

  it('once() unsubscribes automatically after the first emit', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('game.ready', () => count++);
    bus.emit('game.ready', { tick: 0 });
    bus.emit('game.ready', { tick: 1 });
    expect(count).toBe(1);
  });

  it('off() stops delivery', () => {
    const bus = new EventBus();
    let count = 0;
    const handler = (): void => {
      count += 1;
    };
    bus.on('game.paused', handler);
    bus.emit('game.paused', {});
    bus.off('game.paused', handler);
    bus.emit('game.paused', {});
    expect(count).toBe(1);
  });

  it('isolates handler errors — other handlers still run', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger(sink, 'error');
    const bus = new EventBus(logger);
    let goodCount = 0;
    bus.on('combat.entityDestroyed', () => {
      throw new Error('boom');
    });
    bus.on('combat.entityDestroyed', () => {
      goodCount += 1;
    });
    bus.emit('combat.entityDestroyed', { entityId: 'unit-1', sourceId: null });
    expect(goodCount).toBe(1);
    expect(sink.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('unsubscribe function returned by on() works', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('time.tick', () => count++);
    bus.emit('time.tick', { tick: 1, year: 1, month: 1, day: 1, hour: 0 });
    off();
    bus.emit('time.tick', { tick: 2, year: 1, month: 1, day: 1, hour: 1 });
    expect(count).toBe(1);
  });

  it('listenerCount tracks registrations', () => {
    const bus = new EventBus();
    const off = bus.on('save.saved', () => undefined);
    expect(bus.listenerCount('save.saved')).toBe(1);
    off();
    expect(bus.listenerCount('save.saved')).toBe(0);
  });

  it('handlers subscribed during dispatch are not invoked for the current emit', () => {
    const bus = new EventBus();
    let lateCount = 0;
    bus.once('input.actionPressed', () => {
      bus.on('input.actionPressed', () => lateCount++);
    });
    bus.emit('input.actionPressed', { action: 'zoomIn', device: 'keyboard' });
    expect(lateCount).toBe(0);
    bus.emit('input.actionPressed', { action: 'zoomIn', device: 'keyboard' });
    expect(lateCount).toBe(1);
  });
});
