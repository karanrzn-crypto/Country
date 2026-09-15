import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../events/EventBus';
import { TimeSystem } from '../../../time/TimeSystem';
import { DEFAULT_CONFIG } from '../../../config/configTypes';

function makeTime(): { time: TimeSystem; events: EventBus; dayEvents: number[] } {
  const events = new EventBus();
  const dayChanges: number[] = [];
  events.on('time.dayChanged', ({ day }) => dayChanges.push(day));
  return { time: new TimeSystem(DEFAULT_CONFIG.time, events), events, dayEvents: dayChanges };
}

describe('TimeSystem', () => {
  it('advances one tick at a time and emits time.tick', () => {
    const { time } = makeTime();
    expect(time.tick).toBe(0);
    const info = time.advance();
    expect(info.tick).toBe(1);
    expect(time.tick).toBe(1);
  });

  it('maps ticks to calendar dates (24h days, 1h ticks)', () => {
    const { time } = makeTime();
    for (let index = 0; index < 25; index++) time.advance();
    const date = time.date;
    expect(date.hour).toBe(1);
    expect(date.day).toBe(2); // 25 hours after Jan 1 00:00 → Jan 2 01:00
  });

  it('emits dayChanged exactly once per day rollover', () => {
    const { time, dayEvents } = makeTime();
    for (let index = 0; index < 72; index++) time.advance();
    expect(dayEvents).toEqual([2, 3, 4]);
  });

  it('emits monthChanged at month boundaries', () => {
    const events = new EventBus();
    let months = 0;
    events.on('time.monthChanged', () => months++);
    const time = new TimeSystem(DEFAULT_CONFIG.time, events);
    for (let index = 0; index < 24 * 31 + 5; index++) time.advance();
    expect(months).toBe(1);
    expect(time.date.month).toBe(2);
  });

  it('pause state emits game events once', () => {
    const { time, events } = makeTime();
    let paused = 0;
    let resumed = 0;
    events.on('game.paused', () => paused++);
    events.on('game.resumed', () => resumed++);
    time.setPaused(true);
    time.setPaused(true);
    time.setPaused(false);
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
  });

  it('speed is clamped and emits change events', () => {
    const { time, events } = makeTime();
    const speeds: number[] = [];
    events.on('game.speedChanged', ({ speed }) => speeds.push(speed));
    time.setSpeed(4);
    time.setSpeed(99);
    time.setSpeed(0);
    expect(time.speed).toBe(1);
    expect(speeds).toEqual([4, 8, 1]);
  });

  it('setTick (save/restore) does not emit events', () => {
    const { time, events } = makeTime();
    let ticks = 0;
    events.on('time.tick', () => ticks++);
    time.setTick(500);
    expect(time.tick).toBe(500);
    expect(ticks).toBe(0);
  });
});
