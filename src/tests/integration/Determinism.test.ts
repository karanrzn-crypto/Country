import { describe, it, expect } from 'vitest';
import { createTestGame } from '../helpers/testGame';

/**
 * Determinism contract: same seed + same tick sequence ⇒ identical state.
 * This is the backbone for reproducible testing, replays and future
 * lockstep-style verification.
 */
describe('determinism', () => {
  it('two games with the same seed produce identical state after N ticks', () => {
    const a = createTestGame({ seed: 31337 });
    const b = createTestGame({ seed: 31337 });
    a.runTicks(200);
    b.runTicks(200);
    expect(a.stateHash()).toBe(b.stateHash());
    a.dispose();
    b.dispose();
  });

  it('different seeds diverge', () => {
    const a = createTestGame({ seed: 1 });
    const b = createTestGame({ seed: 2 });
    a.runTicks(60);
    b.runTicks(60);
    expect(a.stateHash()).not.toBe(b.stateHash());
    a.dispose();
    b.dispose();
  });

  it('tick count affects the hash (no static state)', () => {
    const a = createTestGame({ seed: 5 });
    const hashBefore = a.stateHash();
    a.runTicks(30);
    expect(a.stateHash()).not.toBe(hashBefore);
    a.dispose();
  });

  it('chunk focus is part of the determinism contract (sim-LOD depends on it)', () => {
    const a = createTestGame({ seed: 9 });
    const b = createTestGame({ seed: 9 });
    a.runTicks(48);
    b.runTicks(48);
    expect(a.stateHash()).toBe(b.stateHash());

    // Move one game's focus; abstract-vs-detailed sim paths will differ.
    a.focusChunk('region_border.c0x0');
    a.runTicks(720); // cross an abstract-update boundary
    b.runTicks(720);
    expect(a.stateHash()).not.toBe(b.stateHash());
    a.dispose();
    b.dispose();
  });
});
