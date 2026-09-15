/**
 * Central error hierarchy for the game.
 *
 * All runtime errors thrown by game systems must extend GameError so callers
 * can distinguish expected, recoverable failures (bad save, invalid data,
 * missing asset) from programming bugs.
 */

export type GameErrorCode =
  | 'E_CONFIG'
  | 'E_VALIDATION'
  | 'E_STATE'
  | 'E_SAVE'
  | 'E_ASSET'
  | 'E_COMMAND'
  | 'E_WORLD'
  | 'E_COMBAT'
  | 'E_AI'
  | 'E_SIM'
  | 'E_TIME'
  | 'E_INPUT'
  | 'E_UI'
  | 'E_GENERIC';

export interface GameErrorDetails {
  readonly [key: string]: unknown;
}

export class GameError extends Error {
  readonly code: GameErrorCode;
  readonly details?: GameErrorDetails;

  constructor(code: GameErrorCode, message: string, details?: GameErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  static is(error: unknown, code?: GameErrorCode): error is GameError {
    if (!(error instanceof GameError)) return false;
    return code === undefined || error.code === code;
  }

  toJSON(): { code: GameErrorCode; message: string; details?: GameErrorDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ConfigError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_CONFIG', message, details);
  }
}

export class DataValidationError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_VALIDATION', message, details);
  }
}

export class StateError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_STATE', message, details);
  }
}

export class SaveError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_SAVE', message, details);
  }
}

export class AssetError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_ASSET', message, details);
  }
}

export class CommandError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_COMMAND', message, details);
  }
}

export class WorldError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_WORLD', message, details);
  }
}

export class CombatError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_COMBAT', message, details);
  }
}

export class AIError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_AI', message, details);
  }
}

export class SimulationError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_SIM', message, details);
  }
}

export class TimeError extends GameError {
  constructor(message: string, details?: GameErrorDetails) {
    super('E_TIME', message, details);
  }
}
