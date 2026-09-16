import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../events/EventBus';
import { TimeSystem, DEFAULT_SPEED_STEPS } from '../../../time/TimeSystem';
import { formatCalendarDate } from '../../../time/Calendar';
import { DEFAULT_CONFIG } from '../../../config/configTypes';
import type { TimeConfig } from '../../../config/configTypes';

function makeTime(overrides: Partial<TimeConfig> = {}): {
  time: TimeSystem;
  events: EventBus;
  dayEvents: number[];
} {
  const events = new EventBus();
  const dayChanges: number[] = [];
  events.on('time.dayChanged', ({ day }) => dayChanges.push(day));
  const config: TimeConfig = { ...DEFAULT_CONFIG.time, ...overrides };
  return { time: new TimeSystem(config, events), events, dayEvents: dayChanges };
}

describe('TimeSystem', () => {
  it('advances one tick at a time and emits time.tick', () => {
    const { time } = makeTime();
    expect(time.tick).toBe(0);
    const info = time.advance();
    expect(info.tick).toBe(1);
    expect(time.tick).toBe(1);
  });

  it('default campaign ticks are 15 minutes (hoursPerTick 0.25)', () => {
    const { time } = makeTime();
    time.advance();
    expect(time.date.hour).toBe(0);
    expect(time.date.minute).toBe(15);
    time.advance();
    time.advance();
    time.advance();
    expect(time.date.hour).toBe(1);
    expect(time.date.minute).toBe(0);
    expect(time.date.day).toBe(1);
  });

  it('maps ticks to calendar dates (24h days, 1h ticks)', () => {
    const { time } = makeTime({ hoursPerTick: 1 });
    for (let index = 0; index < 25; index++) time.advance();
    const date = time.date;
    expect(date.hour).toBe(1);
    expect(date.day).toBe(2); // 25 hours after Jan 1 00:00 → Jan 2 01:00
  });

  it('formats the clock with minutes (HH:MM)', () => {
    const { time } = makeTime({ hoursPerTick: 0.25 });
    for (let index = 0; index < 25; index++) time.advance();
    // 25 × 15 min = 6 h 15 min after 2030-01-01 00:00.
    expect(formatCalendarDate(time.date)).toBe('2030-01-01 06:15');
  });

  it('emits the minute in time.tick payloads', () => {
    const events = new EventBus();
    const minutes: number[] = [];
    events.on('time.tick', ({ minute }) => minutes.push(minute));
    const time = new TimeSystem({ ...DEFAULT_CONFIG.time, hoursPerTick: 0.25 }, events);
    time.advance();
    time.advance();
    time.advance();
    expect(minutes).toEqual([15, 30, 45]);
  });

  it('emits dayChanged exactly once per day rollover', () => {
    const { time, dayEvents } = makeTime({ hoursPerTick: 1 });
    for (let index = 0; index < 72; index++) time.advance();
    expect(dayEvents).toEqual([2, 3, 4]);
  });

  it('day rollover also works with 15-minute ticks', () => {
    const { time, dayEvents } = makeTime({ hoursPerTick: 0.25 });
    for (let index = 0; index < 96 * 2; index++) time.advance();
    expect(dayEvents).toEqual([2, 3]);
    expect(time.date.day).toBe(3);
    expect(time.date.hour).toBe(0);
    expect(time.date.minute).toBe(0);
  });

  it('emits monthChanged at month boundaries', () => {
    const events = new EventBus();
    let months = 0;
    events.on('time.monthChanged', () => months++);
    const time = new TimeSystem({ ...DEFAULT_CONFIG.time, hoursPerTick: 1 }, events);
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

  it('default speed steps are [1, 2, 5, 10] and speed starts at 1×', () => {
    const { time } = makeTime();
    expect(time.speedStepList).toEqual([1, 2, 5, 10]);
    expect(DEFAULT_SPEED_STEPS).toEqual([1, 2, 5, 10]);
    expect(time.speed).toBe(1);
    expect(time.speedStepIndex).toBe(0);
  });

  it('setSpeedStep selects a step, clamps and emits speed + stepIndex', () => {
    const { time, events } = makeTime();
    const changes: { speed: number; stepIndex: number }[] = [];
    events.on('game.speedChanged', (payload) => changes.push({ ...payload }));
    time.setSpeedStep(2);
    expect(time.speed).toBe(5);
    expect(time.speedStepIndex).toBe(2);
    time.setSpeedStep(99); // clamp to the fastest step
    expect(time.speed).toBe(10);
    time.setSpeedStep(-3); // clamp to the slowest step
    expect(time.speed).toBe(1);
    expect(changes.map((change) => change.speed)).toEqual([5, 10, 1]);
    expect(changes.every((change) => typeof change.stepIndex === 'number')).toBe(true);
  });

  it('cycleSpeed advances through the steps and wraps back to 1×', () => {
    const { time } = makeTime();
    time.cycleSpeed();
    expect(time.speed).toBe(2);
    time.cycleSpeed();
    expect(time.speed).toBe(5);
    time.cycleSpeed();
    expect(time.speed).toBe(10);
    time.cycleSpeed();
    expect(time.speed).toBe(1);
    expect(time.speedStepIndex).toBe(0);
  });

  it('setSpeed (value-based) snaps to the nearest step — back-compat', () => {
    const { time, events } = makeTime();
    const speeds: number[] = [];
    events.on('game.speedChanged', ({ speed }) => speeds.push(speed));
    time.setSpeed(4); // nearest step to 4 is 5
    time.setSpeed(99); // clamps to the fastest step (10)
    time.setSpeed(0); // clamps to the slowest step (1)
    time.setSpeed(1); // same as the current step — no event
    expect(time.speed).toBe(1);
    expect(speeds).toEqual([5, 10, 1]);
  });

  it('custom speed steps are data-driven via TimeConfig', () => {
    const { time } = makeTime({ speedSteps: [1, 3, 6] });
    expect(time.speedStepList).toEqual([1, 3, 6]);
    time.setSpeedStep(1);
    expect(time.speed).toBe(3);
    time.setSpeed(4); // nearest of [1,3,6] is 3
    expect(time.speed).toBe(3);
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
