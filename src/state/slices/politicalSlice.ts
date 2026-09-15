/**
 * Political state slice — domestic stability per country.
 */

export interface PoliticalCountryRecord {
  /** 0..1 */
  stability: number;
  /** 0..1 */
  legitimacy: number;
  /** 0..∞ grows during wars, decays in peace. */
  warExhaustion: number;
}

export interface PoliticalSlice {
  countries: Record<string, PoliticalCountryRecord>;
}
