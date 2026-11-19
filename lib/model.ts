// The token radar's model (radar-2): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds every
// other rankable pre-token protocol below the floor: the early rows the radar exists to find. A protocol
// is pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never mixed into
// the ranked board.
//
// Implied value is the estimated fully-diluted value of the token at launch, and follows only from the
// snapshot's own figures plus a per-category multiple calibrated on real launches:
//
//   implied = tvl_usd x MULTIPLE[category] x growthMult x maturityMult
//
//   MULTIPLE[category]  the geometric mean of FDV/TVL at launch across real token launches in that
//                       category (day-0 and day-7 after launch), winsorized to [0.05, 10]. A category
//                       with one launch is shrunk halfway toward the global mean in log space; a
//                       category with no launch uses the closest measured category, or the global mean.
//                       The launches, their TVL at launch (DefiLlama) and their FDV at launch (first
//                       price x max supply) are listed in research/comparables.json and shown on the
//                       dashboard's calibration panel. No protocol name is ever special-cased.
//   growthMult          = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturityMult        = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365 days)
//
// The constants are the house model's growth and maturity shapes with the starter's flat 0.25x base
// multiple replaced by the calibrated per-category table below.

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
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/**
 * The calibrated per-category launch multiples: geometric mean of FDV/TVL at launch across the real
 * launches in research/comparables.json, winsorized to [0.05, 10].
 *
 * Measured categories (n = launches behind the figure; per-launch ratio = geomean of day-0 and
 * day-7 FDV/TVL; n=1 shrunk halfway toward the global mean in log space):
 *   Dexs 5.118 (n=2: Jupiter 57.04x, Aerodrome 0.46x)
 *   Bridge 3.139 (n=1: Wormhole 5.47x)
 *   Derivatives 3.229 (n=3: Hyperliquid 6.61x, Drift 1.15x, Zeta Markets 4.42x)
 *   Lending 0.310 (n=3: Morpho 0.68x, Kamino 0.53x, Dolomite 0.08x)
 *   Liquid Staking 2.690 (n=2: ether.fi 1.23x, Jito 5.88x)
 *   RWA 2.225 (n=1: Usual 2.75x)
 *   Restaking 0.559 (n=2: EigenLayer 0.60x, Renzo 0.52x)
 *   Basis Trading 3.704 (n=1: Ethena 7.62x)
 *   Global 1.801 (all 15 app-token launches)
 * Excluded from calibration: chain (L1/L2) tokens — valued on ecosystem potential, not TVL
 * (Starknet ~120-340x, zkSync ~40x vs app tokens 0.1-10x); the Chain category uses the global
 * mean. Also excluded: Seamless (Lending, ~168x on $8M launch TVL — micro-TVL outlier; would
 * lift the Lending multiple ~5x on one noisy observation) and launches with no computable
 * ratio (Puffer, Swell, LayerZero, Celestia, Movement, Dymension, Ondo, Maple/Syrup, Plume).
 * Mapped categories use the closest measured one; the rest use the global mean.
 * (Table is filled from research/comparables.json; update the numbers, never the shape.)
 */
export const MULTIPLES: Record<string, number> = {
  Dexs: 5.118,
  Bridge: 3.139,
  'Canonical Bridge': 3.139,
  'Cross Chain': 3.139,
  'Cross Chain Bridge': 3.139,
  RWA: 2.225,
  Restaking: 0.559,
  'Liquid Restaking': 0.559,
  'Restaked BTC': 0.559,
  'Collateral Markets': 0.559,
  Lending: 0.31,
  'Risk Curators': 0.31,
  'Onchain Capital Allocator': 0.31,
  'Liquid Staking': 2.69,
  'Staking Pool': 2.69,
  'Basis Trading': 3.704,
  CDP: 3.704,
  'Stablecoin Wrapper': 3.704,
  Derivatives: 3.229,
  'Leveraged Farming': 0.31,
  Yield: 1.801,
  'Yield Aggregator': 1.801,
  Chain: 1.801,
  CeDeFi: 1.801,
  Payments: 1.801,
  Insurance: 1.801,
  'Governance Incentives': 1.801,
  'Prediction Market': 1.801,
  Options: 1.801,
  Privacy: 1.801,
  'AI Agents': 1.801,
  Launchpad: 1.801,
  Indexes: 1.801,
  'Liquidity Manager': 1.801,
  'NFT Marketplace': 1.801,
  'Token Locker': 1.801,
  'Dual-Token Stablecoin': 3.704,
  DOR: 1.801,
  'Collateral Management': 0.31,
  'Decentralized AI': 1.801,
  CEX: 1.801,
  Other: 1.801,
};

/** The global fallback multiple: the geometric mean across every measured launch. */
export const GLOBAL_MULTIPLE = 1.801;

/** How many launches back each measured multiple, for the dashboard's calibration panel. */
export const MULTIPLE_N: Record<string, number> = {
  Dexs: 2,
  Bridge: 1,
  Derivatives: 3,
  Lending: 3,
  'Liquid Staking': 2,
  RWA: 1,
  Restaking: 2,
  'Basis Trading': 1,
};

/** The multiple one category gets: its table entry, else the global mean. */
export function multipleFor(category: string | null): number {
  if (category !== null && Object.prototype.hasOwnProperty.call(MULTIPLES, category)) return MULTIPLES[category]!;
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
    multiple: number;
    multiple_basis: string;
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

/** One calibration row for the dashboard: category, multiple, launches behind it. */
export interface CalibrationRow {
  category: string;
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

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; multiple: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, multipleFor(protocol.category)));
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, multiple, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

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
const ST_TOKEN = /\bst[A-Z]{2,}\b/;
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
  // The early radar: every other rankable pre-token protocol, strongest TVL first. Never a replacement
  // for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, multiple, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model);
    return { p, implied, multiple, growthPct, growthMult, maturityMult, age };
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
      multiple_basis: multipleBasis(s.p.category),
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

/** Where a category's multiple comes from, in the dashboard's words. */
export function multipleBasis(category: string | null): string {
  if (category !== null && Object.prototype.hasOwnProperty.call(MULTIPLE_N, category)) {
    const n = MULTIPLE_N[category]!;
    return `${n} launch${n === 1 ? '' : 'es'} in this category`;
  }
  if (category !== null && Object.prototype.hasOwnProperty.call(MULTIPLES, category)) return 'closest measured category';
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

/** The calibration table the dashboard shows: measured categories first, then the mappings. */
export function calibrationRows(): CalibrationRow[] {
  const measured = Object.keys(MULTIPLE_N).sort();
  const rows: CalibrationRow[] = measured.map((c) => ({
    category: c,
    multiple: MULTIPLES[c]!,
    launches: MULTIPLE_N[c]!,
    basis: 'median launch FDV/TVL',
  }));
  const mapped = Object.keys(MULTIPLES)
    .filter((c) => !Object.prototype.hasOwnProperty.call(MULTIPLE_N, c) && c !== 'Other')
    .sort();
  for (const c of mapped) {
    rows.push({ category: c, multiple: MULTIPLES[c]!, launches: 0, basis: multipleBasis(c) });
  }
  rows.push({ category: 'Any other category', multiple: GLOBAL_MULTIPLE, launches: 0, basis: 'global mean across all launches' });
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
