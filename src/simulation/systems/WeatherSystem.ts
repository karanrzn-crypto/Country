import type { SystemContext } from '../../core/GameContext';
import type { TickInfo } from '../../time/TimeSystem';
import type { SimulationSystemDef } from '../SimulationEngine';

const WEATHER_INTERVAL_TICKS = 12;

/**
 * Deterministic weather simulation. Consumes the shared seeded RNG only on
 * interval ticks, so the RNG stream stays aligned across save/load and
 * identical seeds always produce identical weather.
 *
 * The interval counts SIM STEPS (TimeSystem.step — restored by saves), NOT
 * clock minutes: the time mode defines how the clock moves, weather evolves
 * on its own sim cadence — the two are deliberately decoupled.
 */
export class WeatherSystem implements SimulationSystemDef {
  readonly id = 'weather';

  tick(context: SystemContext, _tick: TickInfo): void {
    if (context.time.step % WEATHER_INTERVAL_TICKS !== 0) return;
    const { state, rng, events } = context;
    const regions = Object.keys(state.world.regions);
    if (regions.length === 0) return;

    for (const regionId of regions) {
      const roll = rng.next();
      const weather = roll < 0.5 ? 'clear' : roll < 0.75 ? 'cloudy' : roll < 0.92 ? 'rain' : 'storm';
      if (state.environment.weather[regionId] !== weather) {
        state.environment.weather[regionId] = weather;
        events.emit('sim.weatherChanged', { regionId, weather });
      }
    }
  }
}
