import type { TimeConfig } from '../config/configTypes';
import type { EventBus } from '../events/EventBus';
import { hoursToCalendar, HOURS_PER_DAY } from './Calendar';
import type { CalendarDate, CalendarStart } from './Calendar';

export interface TickInfo {
  readonly tick: number;
  readonly date: CalendarDate;
  readonly hoursPerTick: number;
}

/**
 * Time-speed steps (multipliers of the fixed sim rate). THE single place the
 * game reads available speeds from — UI buttons and input actions are
 * generated from this list, so adding a future speed is a one-line change.
 */
export const DEFAULT_SPEED_STEPS: readonly number[] = [1, 2, 5, 10];

/**
 * Owns the game clock: current tick, pause state and simulation speed.
 * One call to `advance()` equals one fixed simulation step and emits the
 * time events (tick / day / month / year). Pure and deterministic — the
 * renderer never touches this; it only observes emitted state.
 *
 * Single-source-of-truth contract: NO other system may keep its own clock,
 * speed multiplier or pause flag — everything time-related reads here
 * (directly via SystemContext.time, or from the emitted time.* events).
 */
export class TimeSystem {
  private currentTick = 0;
  private paused = false;
  private readonly speedSteps: readonly number[];
  private speedIndex = 0;
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

  get tick(): number {
    return this.currentTick;
  }

  get date(): CalendarDate {
    return hoursToCalendar(this.currentTick * this.timeConfig.hoursPerTick, this.start);
  }

  get isPaused(): boolean {
    return this.paused;
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

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.events.emit(paused ? 'game.paused' : 'game.resumed', {});
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  /** Used by save/load; does not emit events (load emits its own). */
  setTick(tick: number): void {
    this.currentTick = Math.max(0, Math.floor(tick));
  }

  /** Advances exactly one fixed simulation step and emits time events. */
  advance(): TickInfo {
    const previous = this.date;
    this.currentTick += 1;
    const date = this.date;
    const info: TickInfo = {
      tick: this.currentTick,
      date,
      hoursPerTick: this.timeConfig.hoursPerTick
    };
    this.events.emit('time.tick', {
      tick: info.tick,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: date.hour,
      minute: date.minute
    });
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
    return this.currentTick * this.timeConfig.hoursPerTick;
  }

  get hoursPerTick(): number {
    return this.timeConfig.hoursPerTick;
  }

  get hoursPerDay(): number {
    return HOURS_PER_DAY;
  }
}
