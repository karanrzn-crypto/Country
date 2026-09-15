import { describe, it, expect } from 'vitest';
import { CommandBus } from '../../../core/CommandBus';
import { Logger, MemoryLogSink } from '../../../utils/Logger';
import { CommandError } from '../../../utils/errors';

describe('CommandBus', () => {
  it('queues commands and flushes them FIFO', () => {
    const bus = new CommandBus();
    const processed: string[] = [];
    bus.register('game.togglePause', () => processed.push('pause'));
    bus.register('game.setSpeed', (cmd) => processed.push(`speed:${cmd.speed}`));

    bus.send({ type: 'game.setSpeed', speed: 3 });
    bus.send({ type: 'game.togglePause' });
    expect(bus.pending).toBe(2);
    bus.flush();
    expect(processed).toEqual(['speed:3', 'pause']);
    expect(bus.pending).toBe(0);
  });

  it('warns about unregistered command types without crashing', () => {
    const sink = new MemoryLogSink();
    const bus = new CommandBus(new Logger(sink, 'warn'));
    bus.send({ type: 'game.togglePause' });
    expect(() => bus.flush()).not.toThrow();
    expect(sink.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('isolates handler errors', () => {
    const bus = new CommandBus();
    const processed: string[] = [];
    bus.register('game.togglePause', () => {
      throw new Error('nope');
    });
    bus.register('game.setSpeed', (cmd) => processed.push(`${cmd.speed}`));
    bus.send({ type: 'game.togglePause' });
    bus.send({ type: 'game.setSpeed', speed: 2 });
    expect(() => bus.flush()).not.toThrow();
    expect(processed).toEqual(['2']);
  });

  it('rejects duplicate handlers', () => {
    const bus = new CommandBus();
    bus.register('game.togglePause', () => undefined);
    expect(() => bus.register('game.togglePause', () => undefined)).toThrowError(CommandError);
  });
});
