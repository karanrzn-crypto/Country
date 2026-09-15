/**
 * Levelled logger with pluggable sinks.
 *
 * - `ConsoleLogSink` — default human sink.
 * - `MemoryLogSink`  — ring buffer used in tests and headless runs.
 * Loggers are cheap to fork via `child(prefix)`; systems receive a prefixed child.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100
};

export interface LogEntry {
  readonly level: Exclude<LogLevel, 'off'>;
  readonly prefix: string;
  readonly message: string;
  readonly details?: unknown;
  readonly time: number;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

export class ConsoleLogSink implements LogSink {
  write(entry: LogEntry): void {
    const tag = entry.prefix.length > 0 ? `[${entry.prefix}]` : '';
    const method: string = entry.level === 'debug' ? 'log' : entry.level;
    const fn = (console as unknown as Record<string, (...args: unknown[]) => void>)[method];
    fn(`${tag} ${entry.message}`, entry.details !== undefined ? entry.details : '');
  }
}

export class MemoryLogSink implements LogSink {
  readonly entries: LogEntry[] = [];

  constructor(private readonly capacity = 1000) {}

  write(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export class Logger {
  constructor(
    private readonly sink: LogSink,
    private level: LogLevel = 'info',
    private readonly prefix = ''
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  child(prefix: string): Logger {
    const full = this.prefix.length > 0 ? `${this.prefix}.${prefix}` : prefix;
    return new Logger(this.sink, this.level, full);
  }

  debug(message: string, details?: unknown): void {
    this.write('debug', message, details);
  }

  info(message: string, details?: unknown): void {
    this.write('info', message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write('warn', message, details);
  }

  error(message: string, details?: unknown): void {
    this.write('error', message, details);
  }

  private write(level: Exclude<LogLevel, 'off'>, message: string, details?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    this.sink.write({ level, prefix: this.prefix, message, details, time: Date.now() });
  }
}
