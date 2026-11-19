// The token radar's model (radar-3): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds every
// other pre-token protocol in the snapshot: the radar ranks every protocol that records no token, not
// just the watchlist and the rankable subset. A protocol is pre-token when its index entry records no
// token (no market cap, no CoinGecko id, no symbol); the snapshot's live-token protocols are kept
// apart and shown as the market's own values, never mixed into the ranked board.
//
// Implied value is the estimated fully-diluted value of the token at launch, and follows only from the
// snapshot's own figures plus a per-category power law fitted on real launches:
//
//   implied = exp(INTERCEPT[category] + SLOPE x ln(tvl_usd)) x growthMult x maturityMult
//
//   INTERCEPT[category]  the intercept of log(FDV) on log(TVL) for that category, fitted on the real
//                        launches in research/comparables-v2.json (67 usable launches; 5-fold CV
//                        median log error ~1.0 vs ~1.44 for constant multiples). A category with no
//                        credible estimate uses the global intercept. The launches, their TVL at
//                        launch (DefiLlama) and their FDV at launch (first price x max supply) are
//                        listed in research/comparables-v2.json and shown on the dashboard's
//                        calibration panel. No protocol name is ever special-cased.
//   SLOPE              0.418, common across categories: FDV grows far slower than TVL, so the
//                        implied FDV/TVL ratio falls as a protocol gets bigger.
//   growthMult         = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturityMult       = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365 days)
//
// The constant per-category multiples (research/multiples-v2.json, geometric mean of winsorized
// FDV/TVL) are kept below as a documented fallback, not the active model: validation showed they
// predict no better than the v1 multiples, while the power law clearly does. The effective
// FDV/TVL ratio a protocol gets under the power law (its base divided by its TVL) is what the
// board and the dashboard show as its "multiple" — it is a function of the protocol's TVL and
// category, never a hand-written per-protocol value.

// Gas costs in the farm plans are measured, not guessed: repo/data/gas-costs.json is a
// timestamped snapshot of farm_plan.action_costs_usd() (execution cost per action, plus the
// one-time Solana token-account rent), read at build time. A chain the snapshot does not
// cover keeps a static estimate, marked as such in the step. Refresh the snapshot before
// the final submit if it is days old: gas prices move.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  /** The power law's common slope: log(FDV) = intercept + power_slope x log(TVL). */
  power_slope: number;
  /** The power law's intercept for a category with no credible estimate of its own (RWA included). */
  power_intercept_global: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 10,
  power_slope: 0.418,
  power_intercept_global: 12.311,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/**
 * The power law's per-category intercepts: log(FDV) = a_category + 0.418 x log(TVL), fitted on the
 * 67 usable launches in research/comparables-v2.json (research/multiples-v2.json). A category with
 * no credible estimate of its own uses the global intercept 12.311 — RWA included, because its two
 * usable launches (Usual 2.75x, Goldfinch 68x winsorized to 10x) do not make a credible category
 * estimate: RWA's on-chain TVL misses the off-chain loan book, so its ratios are inflated by
 * structure, not by value. Aliases map a snapshot category to the closest measured one; anything
 * unlisted uses the global intercept.
 *
 * Measured intercepts (n = launches behind the figure):
 *   Basis Trading 12.861 (n=3)   Bridge 12.192 (n=7)   CDP 12.719 (n=5)
 *   Derivatives 12.856 (n=8)     Dexs 12.797 (n=11)    Lending 11.584 (n=14)
 *   Liquid Staking 12.616 (n=9)  RWA 12.311 = global   Restaking 11.258 (n=6)
 *   Yield 11.870 (n=2)           Global 12.311 (all 67 launches)
 * Implied ratios the law gives: at $100M TVL, Basis Trading 8.56x, Derivatives 8.51x, Dexs 8.02x,
 * CDP 7.43x, Liquid Staking 6.70x, RWA 5.20x, Bridge 4.38x, Yield 3.18x, Lending 2.39x,
 * Restaking 1.72x; at $1B TVL the same categories run 2.24x down to 0.45x — the ratio falls with
 * size, which is what the data says (Spark, EigenLayer and Dolomite launched below 1x on
 * billion-dollar TVL). No protocol name is ever special-cased.
 */
export const POWER_INTERCEPTS: Record<string, number> = {
  'Basis Trading': 12.861,
  Bridge: 12.192,
  'Canonical Bridge': 12.192,
  'Cross Chain': 12.192,
  'Cross Chain Bridge': 12.192,
  CDP: 12.719,
  Derivatives: 12.856,
  Dexs: 12.797,
  Lending: 11.584,
  'Risk Curators': 11.584,
  'Onchain Capital Allocator': 11.584,
  'Leveraged Farming': 11.584,
  'Collateral Management': 11.584,
  'Liquid Staking': 12.616,
  'Staking Pool': 12.616,
  RWA: 12.311,
  Restaking: 11.258,
  'Liquid Restaking': 11.258,
  'Restaked BTC': 11.258,
  'Collateral Markets': 11.258,
  Yield: 11.87,
  'Yield Aggregator': 11.87,
  'Stablecoin Wrapper': 12.861,
  'Dual-Token Stablecoin': 12.861,
};

/** The global intercept: the fallback for a category with no credible estimate of its own. */
export const GLOBAL_INTERCEPT = 12.311;

/** How many launches back each measured intercept, for the dashboard's calibration panel. */
export const POWER_N: Record<string, number> = {
  'Basis Trading': 3,
  Bridge: 7,
  CDP: 5,
  Derivatives: 8,
  Dexs: 11,
  Lending: 14,
  'Liquid Staking': 9,
  Restaking: 6,
  Yield: 2,
};

/** The intercept one category gets: its table entry, else the global intercept. */
export function interceptFor(category: string | null): number {
  if (category !== null && Object.prototype.hasOwnProperty.call(POWER_INTERCEPTS, category)) return POWER_INTERCEPTS[category]!;
  return GLOBAL_INTERCEPT;
}

/**
 * The constant per-category multiples (research/multiples-v2.json): the geometric mean of
 * FDV/TVL at launch across the same 67 launches, winsorized to [0.05, 10]. DOCUMENTED
 * FALLBACK ONLY — not the active model. Validation showed constant multiples predict no better
 * than the v1 multiples (5-fold CV median log error 1.435 vs 1.371), while the power law above
 * clearly does (0.991 global / 1.030 per-category). Kept so the dashboard can show the
 * fallback beside the power law, and so a later decision to return to constant multiples has
 * the numbers ready. Same aliases as the intercepts; RWA uses the global multiple.
 */
export const MULTIPLES_V2: Record<string, number> = {
  'Basis Trading': 2.062,
  Bridge: 2.065,
  'Canonical Bridge': 2.065,
  'Cross Chain': 2.065,
  'Cross Chain Bridge': 2.065,
  CDP: 4.176,
  Derivatives: 6.545,
  Dexs: 3.966,
  Lending: 0.907,
  'Risk Curators': 0.907,
  'Onchain Capital Allocator': 0.907,
  'Leveraged Farming': 0.907,
  'Collateral Management': 0.907,
  'Liquid Staking': 2.418,
  'Staking Pool': 2.418,
  RWA: 2.113,
  Restaking: 0.403,
  'Liquid Restaking': 0.403,
  'Restaked BTC': 0.403,
  'Collateral Markets': 0.403,
  Yield: 1.726,
  'Yield Aggregator': 1.726,
  'Stablecoin Wrapper': 2.062,
  'Dual-Token Stablecoin': 2.062,
};

/** The fallback's global multiple: the geometric mean across every usable launch. */
export const GLOBAL_MULTIPLE = 2.113;

/** How many launches back each fallback multiple. */
export const MULTIPLE_N_V2: Record<string, number> = {
  'Basis Trading': 3,
  Bridge: 7,
  CDP: 5,
  Derivatives: 8,
  Dexs: 11,
  Lending: 14,
  'Liquid Staking': 9,
  Restaking: 6,
  Yield: 2,
};

/** The fallback multiple one category gets: its v2 table entry, else the global multiple. */
export function multipleForV2(category: string | null): number {
  if (category !== null && Object.prototype.hasOwnProperty.call(MULTIPLES_V2, category)) return MULTIPLES_V2[category]!;
  return GLOBAL_MULTIPLE;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    /** The effective FDV/TVL ratio the power law gives this protocol at its TVL: base / tvl_usd. */
    multiple: number;
    multiple_basis: string;
    /** The power-law intercept the protocol's category got. */
    intercept: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One calibration row for the dashboard: category, power-law intercept, fallback multiple, launches behind it. */
export interface CalibrationRow {
  category: string;
  /** The power law's intercept for this category (global intercept when the category has none of its own). */
  intercept: number;
  /** The power law's common slope (0.418 for every category). */
  slope: number;
  /** The constant-multiple fallback (v2) for this category. */
  multiple: number;
  launches: number;
  basis: string;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  calibration: CalibrationRow[];
  rows: RadarRow[];
  live: LiveRow[];
  gas_costs: GasCostsSnapshot | null;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The multipliers and the implied value one protocol gets under `model` (power law, radar-3). */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; multiple: number; intercept: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  // The power law's base: exp(a_category + slope x ln(TVL)). No clamp on the effective ratio —
  // the [0.05, 10] winsorization was a rule for calibrating per-launch ratios, not an output
  // clamp: a small protocol legitimately prices at a high FDV/TVL (the fitted law gives ~28x at
  // $5M TVL on the global intercept), and clamping it would bend the model the validation chose.
  const intercept = interceptFor(protocol.category);
  const base = Math.exp(intercept + model.power_slope * Math.log(Math.max(1, protocol.tvl_usd)));
  const multiple = base / Math.max(1, protocol.tvl_usd);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, multiple, intercept, growthPct, growthMult, maturityMult, age };
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * The watchlist's own exclusion rule, applied to every board row, not just the watchlist: a wrapped,
 * staked or bridged product of a token that already trades is not a protocol still waiting on a launch
 * of its own. WBTC is Bitcoin on Ethereum, Binance Bitcoin is BTC in Binance's product, and a bridge
 * moves a token that already trades; ranking one of them as a launch would be the board's own error.
 * The snapshot carries no parentProtocol field, so that part of the house rule cannot be applied.
 */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;
/** A staked receipt token in the name: stHYPE, stETH, stSOL — a token that already trades. */
const ST_TOKEN = /\bst[A-Z]{2,}/;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged product of a token that trades, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)) &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !ST_TOKEN.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, strongest TVL first. The v1
  // exclusions are restored (Hunter's decision, 20 Nov 2026): a wrapped, staked or bridged
  // product of a token that already trades is not a protocol waiting on a launch of its own,
  // and neither is an exchange or a versioned pool. Never a replacement for a watchlist row:
  // a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, multiple, intercept, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model);
    return { p, implied, multiple, intercept, growthPct, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      multiple: round3(s.multiple),
      multiple_basis: interceptBasis(s.p.category),
      intercept: round3(s.intercept),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Where a category's intercept comes from, in the dashboard's words. */
export function interceptBasis(category: string | null): string {
  if (category === 'RWA') return 'power law, global intercept (category estimate not credible)';
  if (category !== null && Object.prototype.hasOwnProperty.call(POWER_N, category)) {
    const n = POWER_N[category]!;
    return `power law fitted on ${n} launch${n === 1 ? '' : 'es'} in this category`;
  }
  if (category !== null && Object.prototype.hasOwnProperty.call(POWER_INTERCEPTS, category)) return 'power law, closest measured category\u2019s intercept';
  return 'power law, global intercept across all launches';
}

/** Where the fallback multiple comes from, for the calibration table's fallback column. */
export function fallbackBasis(category: string | null): string {
  if (category !== null && Object.prototype.hasOwnProperty.call(MULTIPLE_N_V2, category)) {
    const n = MULTIPLE_N_V2[category]!;
    return `${n} launch${n === 1 ? '' : 'es'} in this category`;
  }
  if (category !== null && Object.prototype.hasOwnProperty.call(MULTIPLES_V2, category)) return 'closest measured category';
  return 'global mean across all launches';
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The gas-cost snapshot: measured execution costs per chain, written by
 * tools/snapshot_costs.py from farm_plan.action_costs_usd() and committed at
 * repo/data/gas-costs.json, so the farm plans quote one timestamped measurement
 * instead of a static table. The snapshot is execution-only: L2 figures exclude
 * the L1 data fee, and Solana figures exclude the one-time first-token-account
 * rent (reported separately as first_account_rent_usd).
 *
 * Two honest limits, stated wherever the numbers are shown: the Solana priority
 * fee is the p75 of network-wide getRecentPrioritizationFees (no account list),
 * so it can understate contention on hot DeFi accounts — the fix would pass the
 * protocol's writable addresses as params and use simulateTransaction for
 * compute units; and the static fallback below is an unmeasured estimate, marked
 * as such in the step that uses it.
 */
export interface GasChainCosts {
  execution_usd: { approve: number; swap: number; deposit: number; bridge: number } | null;
  first_account_rent_usd: number | null;
  entry_usd: number | null;
}
export interface GasCostsSnapshot {
  as_of: string;
  source: string;
  method: string;
  chains: Record<string, GasChainCosts>;
}

/** The committed snapshot, or null when the file is missing or unreadable. */
function loadGasCosts(): GasCostsSnapshot | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(join(here, '..', 'data', 'gas-costs.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.as_of !== 'string' || typeof o.chains !== 'object' || o.chains === null) return null;
    return parsed as GasCostsSnapshot;
  } catch {
    return null;
  }
}
export const GAS_COSTS: GasCostsSnapshot | null = loadGasCosts();

/** Snapshot chain names to the snapshot's keys (the snapshot covers 9 chains). */
const GAS_CHAIN_KEY: Record<string, string> = {
  ethereum: 'ethereum',
  arbitrum: 'arbitrum',
  base: 'base',
  optimism: 'optimism',
  linea: 'linea',
  scroll: 'scroll',
  binance: 'bsc',
  'bnb chain': 'bsc',
  avalanche: 'avax',
  solana: 'solana',
};

/** The snapshot's short date, e.g. "19 Nov 2026", or null when there is no snapshot. */
export function gasCostsDate(): string | null {
  if (GAS_COSTS === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(GAS_COSTS.as_of);
  if (m === null) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/** A cost as the steps quote it: $0.15, $0.025, $0.0047, $0.0004. */
export function fmtUsd(n: number): string {
  if (n >= 0.1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

/** The old static table's unmeasured estimate for a chain, in dollars. */
function staticGasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 4;
  if (c === 'solana') return 0.02;
  if (c === 'bitcoin') return 0.5;
  if (c === 'tron') return 2;
  if (c === 'binance' || c === 'bnb chain') return 0.2;
  if (c === 'avalanche') return 0.4;
  if (c === 'polygon') return 0.1;
  if (c === 'monad' || c === 'megaeth' || c === 'pharos' || c === 'sei') return 0.02;
  if (c === 'bittensor') return 0.1;
  if (c === 'cosmos' || c === 'osmosis' || c === 'xrpl' || c === 'xrp ledger') return 0.1;
  if (c === 'algorand') return 0.01;
  if (c === 'flare' || c === 'plume mainnet' || c === 'ink' || c === 'zircuit' || c === 'mode' || c === 'fraxtal') return 0.1;
  // Layer 2s and the rest of the EVM chains settle for cents.
  return 0.2;
}

/** A chain's gas figures: entry cost (execution + one-time Solana rent), execution deposit, rent, and whether the numbers are measured. */
export interface ChainGas {
  entry: number | null;
  exec: number | null;
  rent: number | null;
  measured: boolean;
}
export function gasForChain(chain: string): ChainGas {
  const key = GAS_CHAIN_KEY[chain.toLowerCase()];
  if (GAS_COSTS !== null && key !== undefined) {
    const c = GAS_COSTS.chains[key];
    if (c !== undefined && c.entry_usd !== null && c.execution_usd !== null) {
      return { entry: c.entry_usd, exec: c.execution_usd.deposit, rent: c.first_account_rent_usd, measured: true };
    }
  }
  const s = staticGasUsd(chain);
  return { entry: s, exec: s, rent: null, measured: false };
}

/** "about $0.0047 of gas", or "under $0.0001 of gas" when the measured figure rounds to zero. */
function gasPhrase(n: number): string {
  return n > 0 ? `about ${fmtUsd(n)} of gas` : 'under $0.0001 of gas';
}

/** The category's primary farm action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} of USDC into a ${name}-curated vault on ${chain} and keep the shares.`;
  if (c.includes('restak') && c.includes('liquid')) return `Mint $${capital} of the liquid restaking token through ${name} on ${chain} and hold it.`;
  if (c.includes('restak')) return `Restake $${capital} of ETH or LST collateral through ${name} on ${chain} and keep the position.`;
  if (c.includes('liquid staking')) return `Stake $${capital} of the chain asset through ${name} on ${chain} and hold the receipt token.`;
  if (c.includes('staking pool')) return `Pool $${capital} of the chain asset in ${name}'s staking pool on ${chain} and keep the receipt.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Deposit $${capital} of USDC into ${name}'s main yield vault on ${chain} and keep the shares.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing real-world asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s synthetic-dollar vault on ${chain} and stake the receipt.`;
  if (c.includes('payment')) return `Open a $${capital} payment channel through ${name} on ${chain} and route one payment a week.`;
  if (c.includes('governance')) return `Lock $${capital} of the governance asset through ${name} on ${chain} and vote once.`;
  if (c.includes('chain')) return `Stake $${capital} of the chain asset through ${name} on ${chain} and keep the delegation.`;
  if (c.includes('cede')) return `Deposit $${capital} of USDC into ${name}'s custodial yield product on ${chain} and keep the balance.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second qualifying action: a different verb from the first, so the plan is not one move repeated. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('curator') || c.includes('allocator')) return `Add a second deposit to another ${name}-curated vault on ${chain}, in a different asset.`;
  if (c.includes('restak') || c.includes('staking')) return `Delegate a second stake through ${name} on ${chain} to a different operator or validator.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow a small amount against the supplied collateral on ${name} and repay it the same week.`;
  if (c.includes('dex')) return `Swap a small amount through ${name}'s router on ${chain} once a week.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Claim the vault's yield on ${name} once and redeposit it instead of withdrawing.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge a second, smaller amount back through ${name} so both directions are used.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Close the hedge on ${name} and open a fresh one, so the account shows two settled trades.`;
  if (c.includes('prediction')) return `Settle one market on ${name} and place a second position in a different market.`;
  if (c.includes('stable') || c.includes('basis')) return `Stake the receipt token from ${name} into its yield vault on ${chain}.`;
  if (c.includes('rwa')) return `Hold the minted asset for one full distribution cycle on ${name} before moving it.`;
  if (c.includes('insurance')) return `Renew the cover on ${name} once so the policy spans two periods.`;
  if (c.includes('payment')) return `Send a second payment through the same ${name} channel on ${chain}.`;
  if (c.includes('governance')) return `Vote on a second proposal through ${name} on ${chain}.`;
  if (c.includes('chain')) return `Delegate to a second validator through ${name} on ${chain}.`;
  return `Use ${name}'s app on ${chain} a second time, in a different feature than the first deposit.`;
}

/** What the protocol's points or rewards program counts, in the category's words. */
function pointsFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('risk curator') || c.includes('curator') || c.includes('allocator')) return `vault deposits and how long they stay in ${p.name}'s curated vaults`;
  if (c.includes('restak')) return `restaked collateral and the operators it is delegated to`;
  if (c.includes('staking') || c.includes('liquid staking')) return `staked assets and the time they stay staked`;
  if (c.includes('lend') || c.includes('cdp')) return `supplied collateral, borrows and the time both stay open`;
  if (c.includes('dex')) return `liquidity provided and swaps routed through the pools`;
  if (c.includes('yield')) return `vault shares held and the yield claimed and redeposited`;
  if (c.includes('bridge')) return `volume bridged in both directions`;
  if (c.includes('perpetual') || c.includes('derivative')) return `margin deposited and trades settled`;
  if (c.includes('prediction')) return `positions placed and markets settled`;
  if (c.includes('stable') || c.includes('basis')) return `stable assets minted and staked receipts held`;
  if (c.includes('rwa')) return `real-world assets minted and held through a distribution`;
  if (c.includes('insurance')) return `cover bought and the time the policy stays active`;
  if (c.includes('payment')) return `payments routed through the channel`;
  if (c.includes('governance')) return `assets locked and votes cast`;
  if (c.includes('chain')) return `assets staked and the delegation's age`;
  return `deposits made and the time they stay in the protocol`;
}

/**
 * Verified points programs, checked 2026-11-19 against each project's own docs or pages
 * (research/points_programs.json in the entry research file carries the source link per slug).
 * Only protocols with a live program are listed; anything absent here is unknown, not "no".
 * The map names the program in the farm plan's points-check step — it never changes a value.
 * Two corrections vs early notes: Mezo "mats" ended January 2026 (MEZO is live) and Plume
 * Nest Points Season 1 ended 13 March 2026, so neither is listed.
 * Re-verified 2026-11-19 against each project's own domain (registry rule: official
 * source only): b14g, firelight and veda REMOVED — b14g has no official-domain proof
 * the program is still live after the 31 Oct 2026 exploit; Firelight Points ended
 * with Phase 1 (eligibility fixed 6 Oct 2026, new deposits earn cover premiums, not
 * points); Veda has no Veda-run points season open per a 13 Nov 2026 check and its
 * own homepage no longer mentions points. Curvance REMOVED 2026-11-19 by Hunter's
 * decision (strict-evidence standard): its Bytes page is wallet-gated and JS-rendered,
 * so liveness could only be shown secondhand (a 29 Oct 2026 third-party reading) —
 * the only one of the 12 whose liveness was not directly verifiable. Reversible if
 * fresh official evidence appears before 14 Dec 2026. 11 programs remain.
 */
export const POINTS_PROGRAMS: Record<string, string> = {
  symbiotic: 'Symbiotic Points',
  infinifi: 'Season 3 points',
  'yuzu-money': 'Yuzu Juice',
  onre: 'OnRe Points',
  upshift: 'Upshift Points (Season 2)',
  axis: 'Coordinates (Season 1)',
  'tori-finance': 'Cores (Season 1)',
  'doppler-finance': 'Doppler Points (Season 3)',
  noble: 'Noble Points (Season 2)',
  saturn: 'Orbital Points (Season 2)',
  tydro: 'TydroInkPoints (Season 2)',
};

/** The points-check step: names the verified program when one is known, else stays generic. */
function pointsStep(p: SnapshotProtocol): string {
  const program = POINTS_PROGRAMS[p.slug];
  if (program) return `Open ${p.name}'s own ${program} page and check that ${pointsFor(p)} are being counted.`;
  return `Open ${p.name}'s own points or rewards page and check that ${pointsFor(p)} are being counted.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasForChain(chain);
  const date = gasCostsDate();
  // The cost figures are measured network fees, dated; the label says so on the step that
  // carries a gas number, and names what the figure leaves out. A chain the snapshot does
  // not cover keeps the old static estimate, marked as unmeasured.
  const label = gas.measured && date !== null
    ? `estimate as of ${date}, execution only, excl. L1 data fee, bridge and slippage`
    : 'static estimate, not measured';
  const entryPhrase = gas.entry !== null ? gasPhrase(gas.entry) : 'about $0.20 of gas';
  const execPhrase = gas.exec !== null ? gasPhrase(gas.exec) : 'about $0.20 of gas';
  const firstCost = gas.rent !== null && gas.entry !== null && gas.exec !== null
    ? `about ${fmtUsd(gas.entry)} for the first transaction on ${chain} (a one-time token-account rent of ${fmtUsd(gas.rent)}, plus ${gasPhrase(gas.exec)})`
    : `${entryPhrase} for the first transaction on ${chain}${gas.measured ? '' : ' (static estimate)'}`;
  const action = actionFor(p, capital, chain);
  const second = secondActionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: firstCost,
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${execPhrase}; ${label}`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: gas.measured ? execPhrase : `${execPhrase} (static estimate)`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week on ${chain}, such as a deposit, a swap, a vote or a claim.`,
      cost: gas.measured ? `${execPhrase} a week` : `${execPhrase} a week (static estimate)`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: pointsStep(p),
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Before you withdraw, claim only from the link the protocol itself publishes, and never pay anyone to claim for you.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The calibration table the dashboard shows: measured intercepts first, then the mappings, then the global row. */
export function calibrationRows(): CalibrationRow[] {
  const measured = Object.keys(POWER_N).sort();
  const rows: CalibrationRow[] = measured.map((c) => ({
    category: c,
    intercept: POWER_INTERCEPTS[c]!,
    slope: MODEL.power_slope,
    multiple: MULTIPLES_V2[c]!,
    launches: POWER_N[c]!,
    basis: interceptBasis(c),
  }));
  const mapped = Object.keys(POWER_INTERCEPTS)
    .filter((c) => !Object.prototype.hasOwnProperty.call(POWER_N, c) && c !== 'RWA')
    .sort();
  for (const c of mapped) {
    rows.push({
      category: c,
      intercept: POWER_INTERCEPTS[c]!,
      slope: MODEL.power_slope,
      multiple: MULTIPLES_V2[c]!,
      launches: 0,
      basis: interceptBasis(c),
    });
  }
  rows.push({
    category: 'RWA',
    intercept: GLOBAL_INTERCEPT,
    slope: MODEL.power_slope,
    multiple: GLOBAL_MULTIPLE,
    launches: 0,
    basis: interceptBasis('RWA'),
  });
  rows.push({
    category: 'Any other category',
    intercept: GLOBAL_INTERCEPT,
    slope: MODEL.power_slope,
    multiple: GLOBAL_MULTIPLE,
    launches: 0,
    basis: 'power law, global intercept across all launches',
  });
  return rows;
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: GLOBAL_MULTIPLE,
    calibration: calibrationRows(),
    rows: board.map(radarRow),
    live,
    gas_costs: GAS_COSTS,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
