import type { SystemContext } from '../../core/GameContext';
import type { TickInfo } from '../../time/TimeSystem';
import type { SimulationSystemDef } from '../SimulationEngine';
import { activeWarsInvolving } from '../../state/slices/warSlice';

const STABILITY_BASELINE = 0.6;
const EXHAUSTION_DAILY_DECAY = 0.002;
const EXHAUSTION_PER_WAR_DAILY = 0.01;

/**
 * Political state foundation: stability drifts toward a baseline reduced by
 * war exhaustion; exhaustion accumulates during wars and decays in peace.
 * Full political gameplay (parties, elections, coups) builds on this later.
 */
export class PoliticalSystem implements SimulationSystemDef {
  readonly id = 'political';

  tick(context: SystemContext, _tick: TickInfo): void {
    if (context.time.step % 24 !== 0) return; // daily sim-step cadence
    const { state } = context;

    for (const [countryId, political] of Object.entries(state.political.countries)) {
      const wars = activeWarsInvolving(state.war, countryId);
      if (wars.length > 0) {
        political.warExhaustion += wars.length * EXHAUSTION_PER_WAR_DAILY;
      } else {
        political.warExhaustion = Math.max(0, political.warExhaustion - EXHAUSTION_DAILY_DECAY);
      }
      const target = Math.max(0.1, STABILITY_BASELINE - political.warExhaustion * 0.3);
      political.stability += (target - political.stability) * 0.05;
    }
  }
}
