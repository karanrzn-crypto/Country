import { GameError } from './errors';

/**
 * Lightweight Result type for recoverable failure paths (asset loading,
 * parsing, validation) where throwing would be too aggressive.
 */
export type Result<T, E extends Error = GameError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Wraps a throwing function into a Result. */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof GameError ? e : new GameError('E_GENERIC', String(e)));
  }
}
