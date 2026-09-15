import type { TimeConfig } from '../config/configTypes';
import type { EventBus } from '../events/EventBus';
import { hoursToCalendar, HOURS_PER_DAY } from './Calendar';
import type { CalendarDate, CalendarStart } from './Calendar';

export interface TickInfo {
  readonly tick: number;
  readonly date: CalendarDate;
  readonly hoursPerTick: number;
}

export const MIN_SPEED = 1;
export const MAX_SPEED = 8;

/**
 * Owns the game clock: current tick, pause state and simulation speed.
 * One call to `advance()` equals one fixed simulation step and emits the
 * time events (tick / day / month / year). Pure and deterministic — the
 * renderer never touches this; it only observes emitted state.
 */
export class TimeSystem {
  private currentTick = 0;
  private paused = false;
  private speedValue = 1;
  private readonly start: CalendarStart;

  constructor(
    private readonly timeConfig: TimeConfig,
    private readonly events: EventBus
  ) {
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

  get speed(): number {
    return this.speedValue;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.events.emit(paused ? 'game.paused' : 'game.resumed', {});
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  setSpeed(speed: number): void {
    const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
    if (clamped === this.speedValue) return;
    this.speedValue = clamped;
    this.events.emit('game.speedChanged', { speed: clamped });
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
      hour: date.hour
    });
    if (date.day !== previous.day) {
      this.events.emit('time.dayChanged', { year: date.year, month: date.month, day: date.day, hour: date.hour });
    }
    if (date.month !== previous.month) {
      this.events.emit('time.monthChanged', { year: date.year, month: date.month, day: date.day, hour: date.hour });
    }
    if (date.year !== previous.year) {
      this.events.emit('time.yearChanged', { year: date.year, month: date.month, day: date.day, hour: date.hour });
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
