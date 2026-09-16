import type { TimeConfig } from '../config/configTypes';
import type { EventBus } from '../events/EventBus';
import {
  minutesToCalendar,
  minutesAfterOneMonth,
  minutesAfterOneYear,
  MINUTES_PER_HOUR,
  MINUTES_PER_DAY,
  HOURS_PER_DAY
} from './Calendar';
import type { CalendarDate, CalendarStart } from './Calendar';

export interface TickInfo {
  /** Elapsed game-minutes since campaign start (the raw clock value). */
  readonly tick: number;
  readonly date: CalendarDate;
  /** GAME-MINUTES the clock advanced THIS tick (0 on non-boundary ticks). */
  readonly minutesAdvanced: number;
  /** Legacy config passthrough (the historical per-tick step). */
  readonly minutesPerTick: number;
}

/**
 * TIME MODES — the UNIT the simulation clock advances in.
 *
 * [ 'hour' ] — one hour per step  (troop movement, short operations)
 * [ 'day'  ] — one day per step
 * [ 'month'] — one calendar month per step
 * [ 'year' ] — one calendar year per step
 *
 * The mode is the GRANULARITY, NOT the pace: pace is the speed multiplier's
 * job (see below). Month/year steps are calendar-exact — real month lengths,
 * day-of-month clamped (Jan 31 → Feb 28), same time-of-day — so the display
 * reads January → February → March and 2026 → 2027 → 2028 without drift.
 */
export type TimeMode = 'hour' | 'day' | 'month' | 'year';

/** Mode list in bar order — data-driven source for the UI segment. */
export const TIME_MODES: readonly TimeMode[] = ['hour', 'day', 'month', 'year'];

/**
 * One clock-unit advance every N simulation ticks (the sim runs at
 * config.sim.tickRateHz — 30 Hz by default), so at ×1 speed:
 *   hour ≈ 5 h/s · day ≈ 2.5 d/s · month ≈ 2 months/s · year ≈ 1.5 y/s.
 * The SPEED multiplier scales the SIM TICK RATE, so ×5/×10 pass mode units
 * proportionally faster — Month + ×10 really sweeps months by.
 */
export const TIME_MODE_TICK_DIVISORS: Readonly<Record<TimeMode, number>> = {
  hour: 6,
  day: 12,
  month: 15,
  year: 20
};

/**
 * Time-speed steps (multipliers of the fixed sim rate). THE single place the
 * game reads available speeds from — UI buttons and input actions are
 * generated from this list, so adding a future speed is a one-line change.
 * Speed is INDEPENDENT of the time mode: mode picks the unit, speed picks
 * how fast the units pass.
 */
export const DEFAULT_SPEED_STEPS: readonly number[] = [1, 5, 10];

/**
 * Owns the game clock: the central Simulation Clock (Year/Month/Day/Hour/
 * Minute over an integer-minute timeline), the TIME MODE, the speed
 * multiplier and the pause state.
 *
 * `advance()` is ONE fixed simulation step. It emits `time.tick` every step
 * (the heartbeat other systems key off) and moves the clock exactly one
 * MODE UNIT every TIME_MODE_TICK_DIVISORS[mode] steps — hour, day, calendar
 * month or calendar year. Every boundary emits its event, so present and
 * future systems subscribe instead of keeping clocks of their own:
 *
 *   time.hourChanged   (OnHourPassed)
 *   time.dayChanged    (OnDayPassed)
 *   time.monthChanged  (OnMonthPassed)
 *   time.yearChanged   (OnYearPassed)
 *
 * Single-source-of-truth contract: NO other system may keep its own clock,
 * mode, speed multiplier or pause flag — everything time-related reads here
 * (directly via SystemContext.time, or from the emitted time.* events).
 * Deterministic — the renderer never touches this; it only observes state.
 */
export class TimeSystem {
  /** Elapsed game-minutes since campaign start — the clock itself. */
  private currentMinutes = 0;
  /** Number of advance() calls (drives the mode-unit cadence). */
  private stepCounter = 0;
  private paused = false;
  private readonly speedSteps: readonly number[];
  private speedIndex = 0;
  private mode: TimeMode = 'hour';
  private readonly start: CalendarStart;

  constructor(
    private readonly timeConfig: TimeConfig,
    private readonly events: EventBus
  ) {
    this.speedSteps = timeConfig.speedSteps ?? DEFAULT_SPEED_STEPS;
    this.start = {
      year: timeConfig.startYear,
      month: timeConfig.startMonth,
      day: timeConfig.startDay
    };
  }

  /** Elapsed game-minutes since campaign start (the raw clock value). */
  get elapsedMinutes(): number {
    return this.currentMinutes;
  }

  /**
   * Legacy alias — historical saves and tooling stored the clock as
   * "1-game-minute ticks", which IS the elapsed-minutes value.
   */
  get tick(): number {
    return this.currentMinutes;
  }

  get date(): CalendarDate {
    return minutesToCalendar(this.currentMinutes, this.start);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Campaign start date (for elapsed-format labels). */
  get startDate(): CalendarStart {
    return this.start;
  }

  /** Current speed multiplier (steps[this.speedIndex]). */
  get speed(): number {
    return this.speedSteps[this.speedIndex];
  }

  /** Available speed multipliers, fastest last (data-driven for UI/input). */
  get speedStepList(): readonly number[] {
    return this.speedSteps;
  }

  get speedStepIndex(): number {
    return this.speedIndex;
  }

  /** Current time mode — the UNIT the clock advances in. */
  get timeMode(): TimeMode {
    return this.mode;
  }

  /** Mode list in bar order (data-driven source for the UI segment). */
  get timeModeList(): readonly TimeMode[] {
    return TIME_MODES;
  }

  get timeModeIndex(): number {
    return TIME_MODES.indexOf(this.mode);
  }

  /** Sim ticks per one clock-unit advance in the current mode. */
  get ticksPerUnit(): number {
    return TIME_MODE_TICK_DIVISORS[this.mode];
  }

  /**
   * The SIM-STEP counter — number of advance() calls since start/load.
   * Interval-style systems (weather / supply / AI / combat respawns…) key
   * their cadence off THIS, never off the clock minutes: sim-step cadence
   * and clock-mode cadence are deliberately independent, and the counter is
   * part of the runtime snapshot so save→load continues identically.
   */
  get step(): number {
    return this.stepCounter;
  }

  /** Selects a speed BY STEP INDEX (clamped) — the primary write path. */
  setSpeedStep(index: number): void {
    const clamped = Math.max(0, Math.min(this.speedSteps.length - 1, Math.floor(index)));
    if (clamped === this.speedIndex) return;
    this.speedIndex = clamped;
    this.events.emit('game.speedChanged', { speed: this.speed, stepIndex: clamped });
  }

  /** Cycles to the next speed step, wrapping back to 1× after the fastest. */
  cycleSpeed(): void {
    this.setSpeedStep((this.speedIndex + 1) % this.speedSteps.length);
  }

  /**
   * Sets a speed by multiplier VALUE — snaps to the nearest step so the
   * step list stays the single source of truth. Kept for back-compat with
   * the existing game.setSpeed command / debug tooling / old saves.
   */
  setSpeed(speed: number): void {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.speedSteps.length; index++) {
      const distance = Math.abs(this.speedSteps[index] - speed);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    this.setSpeedStep(best);
  }

  /** Sets the time mode by value (validated) — the Time Bar's write path. */
  setTimeMode(mode: TimeMode): void {
    if (TIME_MODES.indexOf(mode) < 0) return;
    if (mode === this.mode) return;
    this.mode = mode;
    this.stepCounter = 0; // every mode starts a fresh unit cadence
    this.events.emit('time.modeChanged', { mode, index: this.timeModeIndex });
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.events.emit(paused ? 'game.paused' : 'game.resumed', {});
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  /** Used by save/load; does not emit events (load emits its own). */
  setTick(elapsedMinutes: number, stepCounter = 0): void {
    this.currentMinutes = Math.max(0, Math.floor(elapsedMinutes));
    this.stepCounter = Math.max(0, Math.floor(stepCounter));
  }

  /**
   * Advances exactly one fixed simulation step and emits time events.
   * PAUSE is honored defensively: the game loop never calls advance() while
   * paused (speed → 0), but even a direct call cannot move the clock, the
   * cadence or emit events — paused means FULLY frozen (§7).
   */
  advance(): TickInfo {
    const frozen: TickInfo = {
      tick: this.currentMinutes,
      date: this.date,
      minutesAdvanced: 0,
      minutesPerTick: this.timeConfig.minutesPerTick
    };
    if (this.paused) return frozen;
    const previous = this.date;
    this.stepCounter += 1;
    let minutesAdvanced = 0;
    if (this.stepCounter % TIME_MODE_TICK_DIVISORS[this.mode] === 0) {
      // One MODE UNIT: hour/day are fixed minute amounts; month/year follow
      // the real calendar (clamped day-of-month, same time-of-day).
      const before = this.currentMinutes;
      this.currentMinutes =
        this.mode === 'hour'
          ? this.currentMinutes + MINUTES_PER_HOUR
          : this.mode === 'day'
            ? this.currentMinutes + MINUTES_PER_DAY
            : this.mode === 'month'
              ? minutesAfterOneMonth(this.currentMinutes, this.start)
              : minutesAfterOneYear(this.currentMinutes, this.start);
      minutesAdvanced = this.currentMinutes - before;
    }
    const date = this.date;
    const info: TickInfo = {
      tick: this.currentMinutes,
      date,
      minutesAdvanced,
      minutesPerTick: this.timeConfig.minutesPerTick
    };
    this.events.emit('time.tick', {
      tick: info.tick,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: date.hour,
      minute: date.minute,
      minutesAdvanced: info.minutesAdvanced
    });
    if (date.hour !== previous.hour || date.day !== previous.day || date.month !== previous.month || date.year !== previous.year) {
      this.events.emit('time.hourChanged', {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: date.hour,
        minute: date.minute
      });
    }
    if (date.day !== previous.day || date.month !== previous.month || date.year !== previous.year) {
      this.events.emit('time.dayChanged', {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: date.hour,
        minute: date.minute
      });
    }
    if (date.month !== previous.month || date.year !== previous.year) {
      this.events.emit('time.monthChanged', {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: date.hour,
        minute: date.minute
      });
    }
    if (date.year !== previous.year) {
      this.events.emit('time.yearChanged', {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: date.hour,
        minute: date.minute
      });
    }
    return info;
  }

  /** Hours elapsed since campaign start (helper for external systems). */
  get elapsedHours(): number {
    return this.currentMinutes / MINUTES_PER_HOUR;
  }

  get minutesPerTick(): number {
    return this.timeConfig.minutesPerTick;
  }

  get hoursPerDay(): number {
    return HOURS_PER_DAY;
  }
}
