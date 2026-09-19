/**
 * THE EXPORT-REQUEST TTL (the request-inbox refinement) — a pending request
 * left unanswered for `market.requestTtlMonths` expires BY ITSELF:
 *
 *  T1  the sweep ages old pendings into 'expired' («بی‌پاسخ ماند») while
 *      fresh ones stay pending;
 *  T2  an expired request can no longer be decided (not-pending);
 *  T3  the expiry holds the SAME re-ask cooldown as a rejection — the
 *      asking country cannot instantly pester the president again;
 *  T4  after the cooldown the same buyer can file a FRESH request (the
 *      inbox never permanently blocks the AI).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestGame } from '../../helpers/testGame';
import type { SystemContext } from '../../../core/GameContext';
import {
  requestExport,
  decideExportRequest,
  expireStaleExportRequests,
  exportRequestCooldownActive,
  playerCountryIdOf
} from '../../../economy/contracts';
import { safetyReserveUnits } from '../../../economy/resources';

describe('the export-request TTL (unanswered requests expire)', () => {
  let context: SystemContext;
  let config: any;

  beforeAll(() => {
    const game = createTestGame({ seed: 4242 });
    context = game.gameContext;
    config = context.data.economyData.strategicResources;
  });

  const ids = (): string[] =>
    context.map.countryOrder.filter((id) => context.state.economy.finance[id] !== undefined);

  const player = (): string => {
    const state = context.state;
    if (!state.player.countryConfirmed) {
      state.player.countryId = context.map.countryOrder[0];
      state.player.countryConfirmed = true;
    }
    return state.player.countryId;
  };

  const giveQuota = (countryId: string, resourceId: string, amount: number): void => {
    const record = context.state.economy.resources[countryId]!;
    const spare = Math.ceil(amount / config.market.saleQuotaShare);
    record.stock[resourceId] = spare + safetyReserveUnits(record.consumption, resourceId, config);
    record.production[resourceId] = record.consumption[resourceId] ?? 0;
  };

  it('T1 the sweep expires only the requests past the TTL', () => {
    const state = context.state;
    state.economy.contracts = [];
    state.economy.exportRequests = [];
    const seller = player();
    const buyer = ids()[1];
    giveQuota(seller, 'iron', 200);
    const filed = requestExport(state, buyer, seller, 'iron', 50, 10, config, () => 'ttl-1');
    expect(filed.ok).toBe(true);
    // Month 10 + TTL − 1: still pending.
    const ttl = config.market.requestTtlMonths as number;
    expect(expireStaleExportRequests(state, 10 + ttl - 1, config)).toHaveLength(0);
    expect(state.economy.exportRequests[0]!.status).toBe('pending');
    // Month 10 + TTL: it expires.
    const expired = expireStaleExportRequests(state, 10 + ttl, config);
    expect(expired.map((request) => request.id)).toEqual(['ttl-1']);
    expect(state.economy.exportRequests[0]!.status).toBe('expired');
  });

  it('T2 an expired request can no longer be decided', () => {
    const state = context.state;
    const request = state.economy.exportRequests[0]!;
    const decided = decideExportRequest(state, request.id, true, 30, config, () => 'ttl-2');
    expect(decided).toEqual({ ok: false, reason: 'not-pending' });
  });

  it('T3 the expiry holds the same re-ask cooldown as a rejection', () => {
    const state = context.state;
    const seller = player();
    const buyer = ids()[1];
    const ttl = config.market.requestTtlMonths as number;
    const expiredAt = 10 + ttl;
    expect(
      exportRequestCooldownActive(state, buyer, seller, 'iron', expiredAt + 1, config)
    ).toBe(true);
    // …and after the cooldown the pair is free again.
    expect(
      exportRequestCooldownActive(
        state,
        buyer,
        seller,
        'iron',
        expiredAt + config.market.requestCooldownMonths,
        config
      )
    ).toBe(false);
  });

  it('T4 after the cooldown the buyer can file a FRESH request', () => {
    const state = context.state;
    const seller = player();
    const buyer = ids()[1];
    giveQuota(seller, 'iron', 200);
    const month = 10 + (config.market.requestTtlMonths as number) + config.market.requestCooldownMonths;
    const refiled = requestExport(state, buyer, seller, 'iron', 30, month, config, () => 'ttl-4');
    expect(refiled.ok).toBe(true);
    expect(playerCountryIdOf(state)).toBe(seller);
    expect(state.economy.exportRequests.at(-1)!.status).toBe('pending');
  });
});
