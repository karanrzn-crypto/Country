import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../events/EventBus';
import {
  TimeSystem,
  TIME_MODES,
  TIME_MODE_TICK_DIVISORS,
  DEFAULT_SPEED_STEPS,
  type TimeMode
} from '../../../time/TimeSystem';
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

/** Runs exactly N clock-unit advances in the given mode. */
function runUnits(time: TimeSystem, units: number): void {
  const divisor = time.ticksPerUnit;
  for (let index = 0; index < units * divisor; index++) time.advance();
}

describe('TimeSystem (mode-based simulation clock)', () => {
  // ———————————————— central clock ————————————————

  it('starts at the campaign start date with the clock at 0 minutes', () => {
    const { time } = makeTime();
    expect(time.elapsedMinutes).toBe(0);
    expect(time.date).toEqual({ year: 2030, month: 1, day: 1, hour: 0, minute: 0 });
  });

  it('every advance() emits time.tick (the sim heartbeat) even without clock movement', () => {
    const { time, events } = makeTime();
    const ticks: number[] = [];
    events.on('time.tick', (payload) => ticks.push(payload.minutesAdvanced));
    time.advance();
    time.advance(); // hour cadence is 6 → no clock movement yet
    expect(time.elapsedMinutes).toBe(0);
    expect(ticks).toEqual([0, 0]);
  });

  it('HOUR mode advances the clock exactly one hour per cadence boundary', () => {
    const { time } = makeTime();
    expect(time.timeMode).toBe('hour');
    runUnits(time, 3);
    expect(time.elapsedMinutes).toBe(180);
    expect(time.date.hour).toBe(3);
    expect(formatCalendarDate(time.date)).toBe('2030-01-01 03:00');
  });

  it('DAY mode advances one day per unit with exact midnight rollover', () => {
    const { time } = makeTime();
    time.setTimeMode('day');
    runUnits(time, 2);
    expect(time.elapsedMinutes).toBe(2 * 1440);
    expect(time.date.day).toBe(3);
    expect(time.date.hour).toBe(0);
  });

  it('MONTH mode walks real month lengths (January → February → March)', () => {
    const { time } = makeTime();
    time.setTimeMode('month');
    runUnits(time, 1);
    expect(time.date.month).toBe(2);
    expect(time.date.day).toBe(1);
    expect(time.date.hour).toBe(0);
    runUnits(time, 1);
    expect(time.date.month).toBe(3);
    expect(formatCalendarElapsed(time.date, time.startDate)).toBe(
      'Year 1 — March — Day 1 — 00:00'
    );
  });

  it('MONTH mode keeps the time-of-day and clamps the day-of-month (Jan 31 → Feb 28)', () => {
    const { time } = makeTime();
    // Walk the clock to Jan 31 08:00 in hour mode: 30 days + 8 hours.
    for (let index = 0; index < (30 * 24 + 8) * time.ticksPerUnit; index++) time.advance();
    expect(time.date.month).toBe(1);
    expect(time.date.day).toBe(31);
    expect(time.date.hour).toBe(8);
    time.setTimeMode('month');
    runUnits(time, 1);
    expect(time.date.month).toBe(2);
    expect(time.date.day).toBe(28); // clamped — Feb 31 does not exist
    expect(time.date.hour).toBe(8); // time-of-day preserved
  });

  it('YEAR mode advances the calendar year (2026 → 2027 → 2028)', () => {
    const { time } = makeTime({ startYear: 2026 });
    time.setTimeMode('year');
    runUnits(time, 2);
    expect(time.date.year).toBe(2028);
    expect(time.date.month).toBe(1);
    expect(time.date.day).toBe(1);
  });

  it('YEAR mode rolls December → January of the next year', () => {
    const { time } = makeTime();
    time.setTimeMode('year');
    runUnits(time, 1);
    expect(time.date.year).toBe(2031);
    time.setTimeMode('month');
    runUnits(time, 11);
    expect(time.date.month).toBe(12);
    expect(time.date.year).toBe(2031);
    runUnits(time, 1);
    expect(time.date.year).toBe(2032);
    expect(time.date.month).toBe(1);
  });

  // ———————————————— events (OnHourPassed etc.) ————————————————

  it('emits hourChanged / dayChanged / monthChanged / yearChanged at boundaries', () => {
    const events = new EventBus();
    let hours = 0;
    let days = 0;
    let months = 0;
    let years = 0;
    events.on('time.hourChanged', () => hours++);
    events.on('time.dayChanged', () => days++);
    events.on('time.monthChanged', () => months++);
    events.on('time.yearChanged', () => years++);
    const time = new TimeSystem({ ...DEFAULT_CONFIG.time }, events);
    // One hour-step in HOUR mode: 00:00 → 01:00 — an hour passes, the DAY
    // does not change (midnight was not crossed).
    runUnits(time, 1);
    expect(hours).toBe(1);
    expect(days).toBe(0);
    expect(months).toBe(0);
    // A month-mode unit (01:00 Jan 1 → 01:00 Feb 1) fires monthChanged +
    // dayChanged (the month boundary IS a day rollover) + hourChanged (many
    // hours passed) — one event per advance, not per elapsed hour.
    time.setTimeMode('month');
    runUnits(time, 1);
    expect(months).toBe(1);
    expect(days).toBe(1);
    expect(hours).toBe(2);
    expect(years).toBe(0);
    // A year-mode unit fires all four (Feb 1 2030 → Feb 1 2031).
    time.setTimeMode('year');
    runUnits(time, 1);
    expect(years).toBe(1);
    expect(months).toBe(2);
    expect(days).toBe(2);
    expect(hours).toBe(3);
  });

  it('time.tick payloads carry the real minutes advanced (0 on cadence-only ticks)', () => {
    const { time, events } = makeTime();
    const advanced: number[] = [];
    events.on('time.tick', ({ minutesAdvanced }) => advanced.push(minutesAdvanced));
    runUnits(time, 2); // hour mode: 60 on every 6th tick, 0 otherwise
    const nonZero = advanced.filter((value) => value > 0);
    expect(nonZero).toEqual([60, 60]);
    expect(advanced.length).toBe(12);
  });

  // ———————————————— mode control ————————————————

  it('time modes are the data-driven [hour, day, month, year] list', () => {
    const { time } = makeTime();
    expect(time.timeModeList).toEqual(['hour', 'day', 'month', 'year']);
    expect(TIME_MODES).toEqual(['hour', 'day', 'month', 'year']);
    expect(time.timeModeIndex).toBe(0);
  });

  it('setTimeMode switches the unit, resets the cadence and emits time.modeChanged', () => {
    const { time, events } = makeTime();
    const changes: { mode: TimeMode; index: number }[] = [];
    events.on('time.modeChanged', (payload) => changes.push({ ...payload }));
    time.setTimeMode('month');
    expect(time.timeMode).toBe('month');
    expect(time.timeModeIndex).toBe(2);
    expect(time.ticksPerUnit).toBe(TIME_MODE_TICK_DIVISORS.month);
    time.setTimeMode('month'); // same mode → no event
    expect(changes).toEqual([{ mode: 'month', index: 2 }]);
    // Unknown modes are ignored.
    time.setTimeMode('week' as TimeMode);
    expect(time.timeMode).toBe('month');
  });

  // ———————————————— speed (separate from mode) ————————————————

  it('default speed steps are [1, 5, 10] and speed starts at 1×', () => {
    const { time } = makeTime();
    expect(time.speedStepList).toEqual([1, 5, 10]);
    expect(DEFAULT_SPEED_STEPS).toEqual([1, 5, 10]);
    expect(time.speed).toBe(1);
    expect(time.speedStepIndex).toBe(0);
  });

  it('setSpeedStep selects a step, clamps and emits speed + stepIndex', () => {
    const { time, events } = makeTime();
    const changes: { speed: number; stepIndex: number }[] = [];
    events.on('game.speedChanged', (payload) => changes.push({ ...payload }));
    time.setSpeedStep(1);
    expect(time.speed).toBe(5);
    time.setSpeedStep(99); // clamp to the fastest step
    expect(time.speed).toBe(10);
    time.setSpeedStep(-3); // clamp to the slowest step
    expect(time.speed).toBe(1);
    expect(changes.map((change) => change.speed)).toEqual([5, 10, 1]);
  });

  it('speed NEVER changes the clock value per unit — only the tick rate scales', () => {
    const { time } = makeTime();
    time.setSpeedStep(2); // ×10
    runUnits(time, 3);
    // Three hour-units = 180 minutes regardless of speed — speed scales the
    // RATE ticks arrive at (Game loop accumulator), not the unit size.
    expect(time.elapsedMinutes).toBe(180);
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

  // ———————————————— pause ————————————————

  it('pause emits game events once and resume continues from the same clock', () => {
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

  it('paused TimeSystem is FULLY frozen — no clock, no cadence, no events', () => {
    const { time, events } = makeTime();
    time.setPaused(true);
    let tickEvents = 0;
    events.on('time.tick', () => tickEvents++);
    for (let index = 0; index < 60; index++) time.advance();
    expect(time.elapsedMinutes).toBe(0);
    expect(time.step).toBe(0);
    expect(tickEvents).toBe(0);
  });

  // ———————————————— save / restore ————————————————

  it('setTick (save/restore) restores minutes + step counter and emits no events', () => {
    const { time, events } = makeTime();
    let ticks = 0;
    events.on('time.tick', () => ticks++);
    time.setTick(500, 37);
    expect(time.tick).toBe(500);
    expect(time.step).toBe(37);
    expect(ticks).toBe(0);
    // After restore the cadence continues from the restored counter.
    time.advance();
    expect(time.step).toBe(38);
  });

  it('mode + speed + clock survive a simulated snapshot roundtrip', () => {
    const { time } = makeTime();
    time.setTimeMode('month');
    time.setSpeedStep(1);
    runUnits(time, 5);
    const snapshot = {
      tick: time.tick,
      stepCounter: time.step,
      timeMode: time.timeMode,
      speedStepIndex: time.speedStepIndex
    };
    const restored = makeTime();
    restored.time.setTick(snapshot.tick, snapshot.stepCounter);
    restored.time.setTimeMode(snapshot.timeMode);
    restored.time.setSpeedStep(snapshot.speedStepIndex);
    expect(restored.time.elapsedMinutes).toBe(time.elapsedMinutes);
    expect(restored.time.date).toEqual(time.date);
    expect(restored.time.timeMode).toBe('month');
    expect(restored.time.speed).toBe(5);
  });
});
