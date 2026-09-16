import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../events/EventBus';
import { TimeSystem, DEFAULT_SPEED_STEPS } from '../../../time/TimeSystem';
import { formatCalendarDate, formatCalendarElapsed } from '../../../time/Calendar';
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

describe('TimeSystem (minute-resolution simulated clock)', () => {
  it('advances one tick at a time and emits time.tick', () => {
    const { time } = makeTime();
    expect(time.tick).toBe(0);
    const info = time.advance();
    expect(info.tick).toBe(1);
    expect(time.tick).toBe(1);
    expect(info.minutesPerTick).toBe(1);
  });

  it('default ticks are ONE game minute — the clock steps minute by minute', () => {
    const { time } = makeTime();
    // Campaign starts 2030-01-01 00:00; advance 61 ticks → 01:01 next minute each.
    for (let index = 0; index < 61; index++) time.advance();
    expect(time.date.hour).toBe(1);
    expect(time.date.minute).toBe(1);
    expect(time.date.day).toBe(1);
  });

  it('maps ticks to calendar dates (hour-per-tick fast-forward also works)', () => {
    const { time } = makeTime({ minutesPerTick: 60 });
    for (let index = 0; index < 25; index++) time.advance();
    const date = time.date;
    expect(date.hour).toBe(1);
    expect(date.day).toBe(2); // 25 hours after Jan 1 00:00 → Jan 2 01:00
  });

  it('formats the absolute clock with minutes (HH:MM)', () => {
    const { time } = makeTime();
    for (let index = 0; index < 375; index++) time.advance();
    // 375 minutes = 6 h 15 min after 2030-01-01 00:00.
    expect(formatCalendarDate(time.date)).toBe('2030-01-01 06:15');
  });

  it('formats the campaign-elapsed clock (Year — Month — Day — HH:MM)', () => {
    const { time } = makeTime();
    for (let index = 0; index < 8 * 60; index++) time.advance();
    expect(formatCalendarElapsed(time.date, time.startDate)).toBe(
      'Year 1 — Month 1 — Day 1 — 08:00'
    );
    // Cross the month boundary: Jan 31 23:59 + 1 tick → Month 2, Day 1.
    for (let index = 0; index < (31 * 24 - 8) * 60; index++) time.advance();
    expect(formatCalendarElapsed(time.date, time.startDate)).toBe(
      'Year 1 — Month 2 — Day 1 — 00:00'
    );
  });

  it('rolls the YEAR over correctly (Dec 31 23:59 → next year Jan 1 00:00)', () => {
    const { time } = makeTime({ minutesPerTick: 60 }); // hourly ticks
    // (365 days − 1 minute) after the start → Dec 31, 23:59 of the first year.
    for (let index = 0; index < 365 * 24 - 1; index++) time.advance();
    expect(time.date.year).toBe(2030);
    expect(time.date.month).toBe(12);
    expect(time.date.day).toBe(31);
    expect(time.date.hour).toBe(23);
    time.advance();
    expect(time.date.year).toBe(2031);
    expect(time.date.month).toBe(1);
    expect(time.date.day).toBe(1);
    expect(time.date.hour).toBe(0);
  });

  it('emits the minute in time.tick payloads (natural minute stepping)', () => {
    const events = new EventBus();
    const minutes: number[] = [];
    events.on('time.tick', ({ minute }) => minutes.push(minute));
    const time = new TimeSystem({ ...DEFAULT_CONFIG.time }, events);
    time.advance();
    time.advance();
    time.advance();
    expect(minutes).toEqual([1, 2, 3]);
  });

  it('emits dayChanged exactly once per day rollover', () => {
    const { time, dayEvents } = makeTime({ minutesPerTick: 60 });
    for (let index = 0; index < 72; index++) time.advance();
    expect(dayEvents).toEqual([2, 3, 4]);
  });

  it('day rollover also works with minute ticks (midnight boundary)', () => {
    const { time, dayEvents } = makeTime();
    for (let index = 0; index < 24 * 60 * 2; index++) time.advance();
    expect(dayEvents).toEqual([2, 3]);
    expect(time.date.day).toBe(3);
    expect(time.date.hour).toBe(0);
    expect(time.date.minute).toBe(0);
  });

  it('emits monthChanged at month boundaries with real month lengths', () => {
    const events = new EventBus();
    let months = 0;
    events.on('time.monthChanged', () => months++);
    const time = new TimeSystem({ ...DEFAULT_CONFIG.time }, events);
    // January has 31 days; run 31 days + 5 minutes.
    for (let index = 0; index < 31 * 24 * 60 + 5; index++) time.advance();
    expect(months).toBe(1);
    expect(time.date.month).toBe(2);
  });

  it('emits yearChanged exactly once at the year boundary', () => {
    const events = new EventBus();
    let years = 0;
    let months = 0;
    events.on('time.yearChanged', () => years++);
    events.on('time.monthChanged', () => months++);
    const time = new TimeSystem({ ...DEFAULT_CONFIG.time, minutesPerTick: 60 }, events);
    for (let index = 0; index < 365 * 24 + 1; index++) time.advance();
    expect(years).toBe(1);
    expect(months).toBe(12);
    expect(time.date.year).toBe(2031);
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
