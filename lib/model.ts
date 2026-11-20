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
//   implied_if_launches = exp(INTERCEPT[category] + SLOPE x ln(tvl_usd)) x growthMult x maturityMult
//   implied_value_usd   = round(implied_if_launches x token_odds)
//
//   token_odds  the share of the protocol's peers — same age, size and category — that already
//               record a token, from a logistic model fitted on all 758 snapshot protocols
//               (research/token-odds-model.md). Token odds = peers' record, not a launch forecast:
//               the model is a cross-section snapshot, not a prediction of a future launch, and
//               the dashboard must say so. The fitted age_missing boost (+1.48 logit) is
//               deliberately NOT applied: it is a DefiLlama bookkeeping artefact (rows without a
//               listed_at date), not a launch signal, so the 7 board rows without listed_at get
//               their no-boost odds instead (research §4.4).
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
// cover has no gas figure at all: its steps say the gas is unmeasured and the plan's total
// cannot be calculated. Refresh the snapshot before the final submit if it is days old:
// gas prices move.

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

/** The multiplicative decomposition of one row's implied value: base_usd x growth x maturity x odds = implied_value_usd (within rounding). base_usd is the power law's dollar base, exp(intercept + slope x ln(TVL)); growth and maturity are the value model's own multipliers; odds is the token odds. */
export interface ValueParts {
  base_usd: number;
  growth: number;
  maturity: number;
  odds: number;
}

/**
 * One nearest priced peer: a live-token protocol, same category first, nearest by TVL.
 * mcap_multiple is MARKET CAP / TVL — the snapshot carries market cap, not FDV, so no
 * FDV/TVL multiple can be shown for a peer. Never read it as an FDV multiple.
 */
export interface NearestPeer {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  mcap_multiple: number;
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
  /** The post-odds implied value: round(implied_if_launches_usd x token_odds). The board ranks on this. */
  implied_value_usd: number;
  /** The pre-odds implied value: the power law's launch value if the token launches. */
  implied_if_launches_usd: number;
  /** The token odds (0-1): the peers' record, not a launch forecast. See tokenOdds(). */
  token_odds: number;
  /** The farm verdict from the model's economics — NOT a recommendation to deposit. See farmVerdictFor(). */
  farm_verdict: 'FARM' | 'MARGINAL-THIN' | 'SKIP';
  /** The verdict's net in USD: slice - fees - T-bill forgone. */
  verdict_net_usd: number;
  /** The verdict's net per hands-on hour in USD. */
  verdict_net_per_hour_usd: number;
  /** The farmer's expected slice of the drop in USD (pro-rata by deposit share of TVL). */
  verdict_slice_usd: number;
  /** The farm plan's total gas in USD (0 when unmeasured — see verdict_fees_measured). Four decimals, the plan's own precision ($0.1592): a sub-cent figure such as Doppler's $0.0001 survives instead of rounding to $0.00. */
  verdict_fees_usd: number;
  /** Whether verdict_fees_usd is a measured gas total (false: 0 is a placeholder, not a measurement). */
  verdict_fees_measured: boolean;
  /** The T-bill income forgone by holding the deposit instead, in USD. */
  verdict_tbill_usd: number;
  /** 'verified': the program is verified, so the verdict rests on a real plan. 'conditional': the row is unknown — the verdict is what WOULD pay IF the program verifies AND the token launches. */
  verdict_basis: 'verified' | 'conditional';
  /** The multiplicative parts of the implied value: base x growth x maturity x odds = implied_value_usd (within rounding). */
  value_parts: ValueParts;
  /** The 2-3 nearest live-token protocols by TVL, same category first, with their market-cap multiples. */
  nearest_peers: NearestPeer[];
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
  points_status: 'verified' | 'unknown';
  points_program: string | null;
  points_checked: string | null;
  points_source: string | null;
  /** Verified token status — the authoritative status; see tokenVerificationFor(). */
  token_verification: 'verified-live' | 'verified-pre-token' | 'unclear';
  verified_token_symbol: string | null;
  verification_source: string | null;
  /** The slug this row duplicates (same token, two protocols), or null. */
  duplicate_of: string | null;
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
  implied_if_launches_usd: number;
  token_odds: number;
  farm_verdict: 'FARM' | 'MARGINAL-THIN' | 'SKIP';
  verdict_net_usd: number;
  verdict_net_per_hour_usd: number;
  verdict_slice_usd: number;
  verdict_fees_usd: number;
  verdict_fees_measured: boolean;
  verdict_tbill_usd: number;
  verdict_basis: 'verified' | 'conditional';
  value_parts: ValueParts;
  nearest_peers: NearestPeer[];
  multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  points_status: 'verified' | 'unknown';
  points_program: string | null;
  points_checked: string | null;
  points_source: string | null;
  token_verification: 'verified-live' | 'verified-pre-token' | 'unclear';
  verified_token_symbol: string | null;
  verification_source: string | null;
  duplicate_of: string | null;
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

/** One bucket of the protocol ledger: how many snapshot protocols it holds and their TVL. */
export interface LedgerBucket {
  count: number;
  tvl_usd: number;
}

/**
 * The protocol ledger: every one of the 758 snapshot protocols in exactly one bucket, so the
 * buckets sum to 758. ranked: the board. live_token_shown / live_token_other: protocols that
 * already record a token (the 24 the dashboard's Live view shows, and the rest). The excluded
 * buckets are pre-token protocols the board may not rank, by the first rule that excludes
 * them: excluded_category (Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking /
 * Restaked BTC / CEX), versioned (a name ending in a release whose base slug is itself in the
 * snapshot — a versioned pool of another protocol), wrapped_or_staked (a wrapped, staked or
 * receipt-token name, where "staking" counts only outside Staking Pool / Farm / Chain),
 * exchange_name (an exchange's own name), other_excluded (a pre-token protocol no rule
 * catches — 0 by construction, kept so a future rule change shows up as a non-zero bucket
 * instead of a silent miscount).
 */
export interface Ledger {
  total: number;
  ranked: LedgerBucket;
  live_token_shown: LedgerBucket;
  live_token_other: LedgerBucket;
  excluded_category: LedgerBucket;
  /** The excluded_category bucket broken down by category (CEX, Liquid Staking, ...). */
  excluded_category_by_category: Record<string, number>;
  versioned: LedgerBucket;
  wrapped_or_staked: LedgerBucket;
  exchange_name: LedgerBucket;
  other_excluded: LedgerBucket;
}

/** The verdict model's parameters, so the dashboard can state — and recompute — the verdicts. */
export interface VerdictParams {
  /** The share of the launch FDV allocated to farmers (5%). */
  drop_share: number;
  /** The annual T-bill rate the forgone income is priced at (4%). */
  tbill_annual_rate: number;
  /** FARM needs net above this (USD) AND net/hour above farm_net_per_hour_usd. */
  farm_net_usd: number;
  farm_net_per_hour_usd: number;
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
  /** The token-odds model's validation numbers (ODDS_EVIDENCE). */
  odds_evidence: OddsEvidence;
  /** The farm-verdict model's parameters. */
  verdict_params: VerdictParams;
  /** The protocol ledger: all 758 snapshot protocols, exactly one bucket each. */
  ledger: Ledger;
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

/**
 * Token odds (research/token-odds-model.md, fitted 2026-11-20 on all 758 snapshot protocols,
 * label = symbol non-null, 416 live / 342 pre-token; IRLS fit, cross-checked against scipy BFGS
 * to 1e-7). Logistic regression:
 *
 *   P(token) = sigmoid(eta)
 *   eta = -3.8255402899 + 0.6421129386 x age_years + 0.1431663736 x ln(TVL)
 *         - 0.0219587511 x growth_w + category_effect
 *
 *   age_years   (as_of - listed_at) / 365.25; a row without listed_at imputes the observed
 *               median age (1.8535 years) — and gets NO age_missing boost (see below).
 *   growth_w    change_7d winsorized to [-60, +120] (the value model's own clamp); a row
 *               without change_7d imputes the observed median (-8.23335).
 *   category    one dummy per snapshot category with n >= 15 (14 categories); every other
 *               category pools into "Other", the reference level (effect 0).
 *
 * Token odds = peers' record, not a launch forecast. The model predicts P(already records a
 * token | age, TVL, growth, category) from one snapshot; for a board row — currently pre-token —
 * the honest reading is "the share of peers its age/size/category that already record a token".
 * It is a cross-section, not a survival model: a protocol that survived 4 years without a token
 * has already survived 4 years without launching, so the true P(launch | still pre-token at
 * this age) is lower. The dashboard must carry that label.
 *
 * The fitted age_missing term (+1.4802846397 logit, OR 4.39) is deliberately NOT applied.
 * 89 of the 113 snapshot rows without listed_at are symbol-live: missing listed_at marks legacy
 * / version rows in DefiLlama's bookkeeping, not launch intent. Applying it would lift the 7
 * board rows without listed_at to odds 0.72-0.89 on bookkeeping alone (research §4.4); their
 * shipped odds are the no-boost values (defi-saver 0.64, lightning 0.58, noble 0.52,
 * plasma-one 0.46, kava-mint 0.37, set-protocol 0.49, abstract 0.50).
 *
 * Validation (research/token-odds-model.md §3, §7): Brier 0.181 on the 80/20 test split and
 * 0.192 on 5-fold CV vs a 0.248 base-rate baseline; AUC out-of-fold 0.776; calibration slope
 * 0.83, intercept +0.02 (slightly overconfident at the extremes). Value-model held-out
 * evidence, same report: leave-one-out typical miss x2.98 (flat x3.80) and walk-forward
 * x2.96 (flat x8.82); range holds 47-52% (target 50%).
 */
export const ODDS_INTERCEPT = -3.8255402899;
export const ODDS_AGE = 0.6421129386;
export const ODDS_LN_TVL = 0.1431663736;
export const ODDS_GROWTH = -0.0219587511;
/** The fitted age_missing coefficient (+1.4803 logit). Fitted, validated — and NOT applied: see tokenOdds. */
export const ODDS_AGE_MISSING = 1.4802846397;
/** The observed median age (years) among snapshot rows with a listed_at date: the imputation for rows without one. */
export const ODDS_AGE_MEDIAN_YEARS = 1.8535249829;
/** The observed median change_7d among snapshot rows with one: the imputation for rows without one. */
export const ODDS_GROWTH_MEDIAN = -8.23335;
/** The category effects (vs "Other"): the 14 snapshot categories with n >= 15. */
export const ODDS_CATEGORY: Record<string, number> = {
  'Basis Trading': 0.9195976033,
  Bridge: -0.5893721998,
  CDP: -0.3963748363,
  CEX: -2.1710562025,
  'Canonical Bridge': -1.0222382044,
  Derivatives: 0.0514450693,
  Dexs: 1.017428647,
  Lending: 1.0317324591,
  'Liquid Staking': -0.6190192648,
  'Onchain Capital Allocator': -0.7704664091,
  RWA: 0.1214919717,
  'Risk Curators': -1.4153037969,
  Yield: 0.5548127002,
  'Yield Aggregator': 0.0605703248,
};

/** The odds model's validation numbers, as the dashboard's evidence strip states them. */
export interface OddsEvidence {
  /** 5-fold cross-validated Brier score (0.192) and 80/20 test Brier (0.181). */
  brier_cv: number;
  brier_test: number;
  /** The constant base-rate (0.549) baseline's Brier score. */
  brier_baseline: number;
  /** Out-of-fold calibration slope (ideal 1.0) and intercept (ideal 0.0). */
  calibration_slope: number;
  calibration_intercept: number;
  /** Out-of-fold AUC. */
  auc_oof: number;
  /** Value model, typical miss (exp of median |log error|): leave-one-out and walk-forward. */
  loo_typical_miss: number;
  walkforward_typical_miss: number;
  /** The same, for the flat constant-multiple baseline. */
  flat_loo_typical_miss: number;
  flat_walkforward_typical_miss: number;
  /** Share of actual FDVs inside the 50% interval built from held-out residuals (low-high across the three model specs). */
  range_holds_low: number;
  range_holds_high: number;
  /** What the odds label means: symbol non-null in the snapshot. */
  label: string;
}
export const ODDS_EVIDENCE: OddsEvidence = {
  brier_cv: 0.192,
  brier_test: 0.181,
  brier_baseline: 0.248,
  calibration_slope: 0.83,
  calibration_intercept: 0.02,
  auc_oof: 0.776,
  loo_typical_miss: 2.98,
  walkforward_typical_miss: 2.96,
  flat_loo_typical_miss: 3.8,
  flat_walkforward_typical_miss: 8.82,
  range_holds_low: 0.47,
  range_holds_high: 0.52,
  label: 'symbol non-null (416 of 758 snapshot protocols record a token)',
};

/** One protocol's token odds (0-1) under the fitted logistic model, without the age_missing boost. */
export function tokenOdds(p: SnapshotProtocol, asOf: string): number {
  const age = ageDays(asOf, p.listed_at);
  const ageYears = age === null ? ODDS_AGE_MEDIAN_YEARS : age / 365.25;
  const growth = p.change_7d === null ? ODDS_GROWTH_MEDIAN : Math.min(120, Math.max(-60, p.change_7d));
  const categoryEffect = p.category !== null && Object.prototype.hasOwnProperty.call(ODDS_CATEGORY, p.category) ? ODDS_CATEGORY[p.category]! : 0;
  const eta =
    ODDS_INTERCEPT +
    ODDS_AGE * ageYears +
    ODDS_LN_TVL * Math.log(Math.max(1, p.tvl_usd)) +
    ODDS_GROWTH * growth +
    categoryEffect;
  return 1 / (1 + Math.exp(-eta));
}

/**
 * Whether a protocol records no token at all in the snapshot (no market cap, no CoinGecko id,
 * no symbol). A HEURISTIC for board membership only — it is NOT a verified token status and
 * must never be displayed as "no token": DefiLlama leaves the token fields blank for several
 * live tokens, above all stablecoins (research/tokenless-investigation.md §4: in this snapshot
 * the three-field check collapses to `symbol == null`). The authoritative status is
 * token_verification, from tokenVerificationFor() below.
 */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * DefiLlama's version-marker rule, narrowed (audit P1-3, research/versioned-wrapped-recheck.md):
 * a name ending in a release is a pool of another protocol ONLY when that other protocol — the
 * base slug, the slug with its release suffix stripped — is itself in the snapshot. In this
 * snapshot no pre-token versioned row has its base present (aera-v2/v3, bdex-v3,
 * rocketswap-anubis-v2 and the other eight are the protocol, not a pool of one), so the old
 * blanket rule threw away 11 standalone protocols; the only rows whose base exists
 * (curve-llamalend-v2, pancakeswap-amm-v3, sushiswap-v3) already record a token.
 */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The slug a versioned name's base protocol would carry: the slug with its release suffix
 * stripped ("rocketswap-anubis-v2" -> "rocketswap-anubis", "bancor-v2.1" -> "bancor",
 * "alpaca-finance-2.0" -> "alpaca-finance"). Null when the slug carries no release suffix —
 * then no base can be verified, and the row is treated as a standalone protocol. */
export function versionBaseSlug(slug: string): string | null {
  const m = /^(.*?)(?:-v\d+(?:\.\d+)?|-V\d+(?:\.\d+)?|-\d+\.\d+)$/.exec(slug);
  return m === null ? null : m[1]!;
}

/**
 * Whether a protocol is a versioned pool of another snapshot protocol: its name ends in a
 * release AND its base slug is in the snapshot. Without a slug set to check against, the old
 * blanket rule applies (any versioned name is a pool) — the conservative fallback for a
 * caller that cannot prove the base is absent.
 */
export function isVersionedPool(p: SnapshotProtocol, snapshotSlugs?: ReadonlySet<string>): boolean {
  if (!VERSIONED.test(p.name)) return false;
  if (snapshotSlugs === undefined) return true;
  const base = versionBaseSlug(p.slug);
  return base !== null && snapshotSlugs.has(base);
}

/**
 * The watchlist's own exclusion rule, applied to every board row, not just the watchlist: a wrapped,
 * staked or bridged product of a token that already trades is not a protocol still waiting on a launch
 * of its own. WBTC is Bitcoin on Ethereum, Binance Bitcoin is BTC in Binance's product, and a bridge
 * moves a token that already trades; ranking one of them as a launch would be the board's own error.
 * The snapshot carries no parentProtocol field, so that part of the house rule cannot be applied.
 */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A wrapped product's name: "wrapped" is the receipt-token word. "staked" / "staking" are NOT in
 * this pattern (audit P1-4): every "staked" name in this snapshot is a Liquid Staking row the
 * category rule already excludes, and "staking" names a protocol's own activity in its staking
 * categories — see STAKING_WORD below. */
const WRAPPED_WORD = /\bwrapped\b/i;
/** "staking" in the name: the protocol's own activity when its category says so (a staking pool
 * stakes, a farm stakes, a chain stakes), a receipt-token product anywhere else. */
const STAKING_WORD = /\bstaking\b/i;
/** The categories where "staking" in the name is the protocol's own activity, not a receipt token. */
const STAKING_ALLOWED_CATEGORIES = new Set(['Staking Pool', 'Farm', 'Chain']);
/** A staked receipt token in the name: stHYPE, stETH, stSOL — a token that already trades. */
const ST_TOKEN = /\bst[A-Z]{2,}/;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol's name marks it as a wrapped / staked receipt-token product: "wrapped", or
 * "staking" outside the staking categories, or a staked receipt-token symbol. The ledger's
 * wrapped_or_staked bucket uses this same rule, so the bucket and the board never disagree. */
export function isWrappedOrStakedName(p: SnapshotProtocol): boolean {
  return (
    WRAPPED_WORD.test(p.name) ||
    (STAKING_WORD.test(p.name) && (p.category === null || !STAKING_ALLOWED_CATEGORIES.has(p.category))) ||
    ST_TOKEN.test(p.name)
  );
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged
 * product of a token that trades, not an exchange, not a versioned pool of another snapshot
 * protocol. `snapshotSlugs` is the snapshot's slug set: a versioned name is excluded only when
 * its base slug is in it (see isVersionedPool); without the set the old blanket versioned rule
 * applies.
 */
export function isRankable(p: SnapshotProtocol, snapshotSlugs?: ReadonlySet<string>): boolean {
  return (
    isPreToken(p) &&
    (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)) &&
    !isVersionedPool(p, snapshotSlugs) &&
    !isWrappedOrStakedName(p) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/**
 * Curated token verification (research/tokenless-investigation.md §3, checked 19–20 Nov 2026):
 * 13 board rows sit in categories whose product IS a token — CDP (9), Stablecoin Wrapper (2),
 * Dual-Token Stablecoin (2) — and the snapshot's token fields are blank for all of them.
 * 10 are verified live: 8 through the DefiLlama stablecoin cross-check
 * (repo/data/stablecoin-live.json, read by tokenVerificationFor() below) and 2 by manual
 * curation only (usdcx, kava-mint — the cross-check cannot match them). The other 3 are
 * unclear: swan-dao (SWAN is confirmed but not yet claimable or freely tradable, and no
 * contract address was found — downgraded from verified-live 20 Nov 2026), monolith-market
 * (a stablecoin factory with no token of its own; a duplicate of swan-dao, same SWAN token)
 * and strato-cdp (its USDST stablecoin is live, but the STRATO token itself has not had its
 * TGE). This list is data, not model logic: it corrects the snapshot's blank fields for the
 * rows that were checked, one slug at a time. It never removes a row or changes a value —
 * the board stays 197 rows and the ranking is untouched; only the displayed status becomes honest.
 */
export interface TokenVerification {
  status: 'verified-live' | 'verified-pre-token' | 'unclear';
  symbol: string | null;
  source: string | null;
}

/** Manual curation for the live rows the stablecoin cross-check file cannot match. */
const TOKEN_VERIFICATION_LIVE: Record<string, { symbol: string; source: string }> = {
  usdcx: { symbol: 'USDCX', source: 'CoinGecko: USDCX (xReserve Bridged USDC) traded' },
  'kava-mint': { symbol: 'USDX', source: 'CoinGecko: USDX live (depegged ~$0.70)' },
};

/** The curated rows whose token status is nuanced: a live product token, but no token of the protocol's own (yet). strato-cdp carries its live product symbol so the cross-check can match it. */
const TOKEN_VERIFICATION_UNCLEAR: Record<string, { symbol: string | null; source: string }> = {
  'swan-dao': { symbol: null, source: 'SWAN confirmed but not yet claimable or freely tradable; no contract address found; swanUSD/sSwanUSD live, not SWAN' },
  'monolith-market': { symbol: null, source: 'Monolith is a stablecoin factory with no token of its own; duplicate of swan-dao (same SWAN token)' },
  'strato-cdp': { symbol: 'USDST', source: 'USDST stablecoin live; the STRATO token itself has not had its TGE' },
};

/** Categories whose product is a token: a row here that is not in the curated list above is 'unclear', never silently pre-token. */
export const PRODUCT_TOKEN_CATEGORIES = new Set(['CDP', 'Stablecoin Wrapper', 'Dual-Token Stablecoin']);

/**
 * The DefiLlama stablecoin cross-check (repo/data/stablecoin-live.json, written by
 * tools/crosscheck_stablecoins.py from the board itself): one entry per board row whose
 * product token matches a live stablecoin, with the matched symbol. A non-ambiguous
 * match is verified-live; the file is the authority for those rows, and manual curation
 * above covers only the rows it cannot match. Gate 10 (tools/check_gates.py) fails the
 * build when the file is stale (>30 days) or a match is not reflected on the board.
 */
export interface StablecoinLiveMatch {
  slug: string;
  token_symbol: string | null;
  stablecoin_name: string | null;
  stablecoin_symbol: string | null;
  stablecoin_gecko_id: string | null;
  ambiguous?: boolean;
}
export interface StablecoinLiveFile {
  meta: { as_of: string; source: string };
  matches: StablecoinLiveMatch[];
}
/** The committed cross-check file, or null when it is missing or unreadable. */
function loadStablecoinLive(): StablecoinLiveFile | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(join(here, '..', 'data', 'stablecoin-live.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.meta !== 'object' || o.meta === null || !Array.isArray(o.matches)) return null;
    return parsed as StablecoinLiveFile;
  } catch {
    return null;
  }
}
export const STABLECOIN_LIVE: StablecoinLiveFile | null = loadStablecoinLive();

/** One slug's cross-check match, when the file matches it to a live stablecoin unambiguously. */
function stablecoinLiveMatch(slug: string): StablecoinLiveMatch | null {
  if (STABLECOIN_LIVE === null) return null;
  const m = STABLECOIN_LIVE.matches.find((e) => e.slug === slug);
  if (m === undefined || m.ambiguous === true || typeof m.token_symbol !== 'string') return null;
  return m;
}

/**
 * One protocol's verified token status: 'verified-live' for the rows the stablecoin
 * cross-check file matches (8) and the 2 manual-only rows, 'unclear' for the 3 curated
 * nuanced rows and for any other row in a product-token category the curation has not
 * checked, 'verified-pre-token' for everything else.
 * This — not isPreToken() — is the status the dashboard may display.
 */
export function tokenVerificationFor(p: SnapshotProtocol): TokenVerification {
  const unclear = TOKEN_VERIFICATION_UNCLEAR[p.slug];
  if (unclear !== undefined) return { status: 'unclear', symbol: unclear.symbol, source: unclear.source };
  const liveMatch = stablecoinLiveMatch(p.slug);
  if (liveMatch !== null) {
    return {
      status: 'verified-live',
      symbol: liveMatch.token_symbol,
      source: `DefiLlama stablecoins list: ${liveMatch.stablecoin_name ?? liveMatch.token_symbol} (${liveMatch.stablecoin_symbol ?? liveMatch.token_symbol}) live`,
    };
  }
  const live = TOKEN_VERIFICATION_LIVE[p.slug];
  if (live !== undefined) return { status: 'verified-live', symbol: live.symbol, source: live.source };
  if (p.category !== null && PRODUCT_TOKEN_CATEGORIES.has(p.category)) {
    return { status: 'unclear', symbol: null, source: 'product-token category, not individually verified' };
  }
  return { status: 'verified-pre-token', symbol: null, source: null };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Rows that duplicate another row's token: monolith-market is the Monolith factory and swan-dao is Swan DAO — one SWAN token, its TVL counted twice. Neither is on the 40 watchlist, so coverage is unaffected; the row stays, with a badge. */
const DUPLICATE_OF: Record<string, string> = { 'monolith-market': 'swan-dao' };

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
  // and neither is an exchange or a versioned pool of another snapshot protocol (a versioned
  // name whose base slug is absent from the snapshot IS the protocol — audit P1-3).
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p, snapshotSlugs))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, multiple, intercept, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model);
    // implied is the pre-odds launch value; the board ranks on the post-odds value.
    const odds = tokenOdds(p, snapshot.as_of);
    const impliedPostOdds = Math.max(1, Math.round(implied * odds));
    return { p, impliedIfLaunches: implied, odds, implied: impliedPostOdds, multiple, intercept, growthPct, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const ps = pointsStatusFor(s.p.slug);
    const tv = tokenVerificationFor(s.p);
    const verdict = farmVerdictFor(s.p, s.age, ps, s.impliedIfLaunches, s.odds);
    const baseUsd = s.multiple * Math.max(1, s.p.tvl_usd);
    return {
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
    implied_if_launches_usd: s.impliedIfLaunches,
    token_odds: round4(s.odds),
    farm_verdict: verdict.verdict,
    verdict_net_usd: verdict.net_usd,
    verdict_net_per_hour_usd: verdict.net_per_hour_usd,
    verdict_slice_usd: verdict.slice_usd,
    verdict_fees_usd: verdict.fees_usd,
    verdict_fees_measured: verdict.fees_measured,
    verdict_tbill_usd: verdict.tbill_usd,
    verdict_basis: verdict.basis,
    value_parts: {
      base_usd: Math.round(baseUsd),
      growth: round4(s.growthMult),
      maturity: round4(s.maturityMult),
      odds: round4(s.odds),
    },
    nearest_peers: nearestPeersFor(s.p, snapshot),
    model: {
      multiple: round3(s.multiple),
      multiple_basis: interceptBasis(s.p.category),
      intercept: round3(s.intercept),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, ps).map(stepText),
    points_status: ps.status,
    points_program: ps.program,
    points_checked: ps.checked,
    points_source: ps.source,
    token_verification: tv.status,
    verified_token_symbol: tv.symbol,
    verification_source: tv.source,
    duplicate_of: DUPLICATE_OF[s.p.slug] ?? null,
    };
  });
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
 * compute units; and a chain the snapshot does not cover has no gas figure at all,
 * so its steps say the gas is unmeasured and its total cannot be calculated.
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
  ink: 'ink',
  plasma: 'plasma',
};

/**
 * Chains with no token-allowance model, matched case-insensitively on the chain's first
 * name: Solana (SPL deposits move by direct transfer), Ripple/XRPL (no approve; a Payment
 * costs 10 drops, tokens move through trust lines) and Noble/Cosmos appchains (no ERC-20
 * approve; native transfer or delegation). A farm plan on one of these has no approve step,
 * no revoke and no approval cost; the Solana one-time token-account rent stays, named on
 * the main action. Anything not listed here is treated as an EVM-style allowance chain.
 */
const NO_ALLOWANCE_CHAINS = new Set(['solana', 'ripple', 'xrpl', 'noble', 'cosmos']);

/** The snapshot's short date, e.g. "19 Nov 2026", or null when there is no snapshot. */
export function gasCostsDate(): string | null {
  if (GAS_COSTS === null) return null;
  return fmtDay(GAS_COSTS.as_of);
}

/** A YYYY-MM-DD date (or a timestamp starting with one) as "19 Nov 2026", or null when it does not parse. */
export function fmtDay(iso: string | null): string | null {
  if (iso === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/** A source link's host ("docs.axis.to"), or null when there is no source. No scheme is ever printed. */
export function domainOf(source: string | null): string | null {
  if (source === null) return null;
  const parts = source.split('/');
  return parts.length > 2 && parts[2] !== '' ? parts[2]! : null;
}

/** A gas cost as the steps quote it, always to four decimals ($0.1592, $0.0004): the total step adds the same figures, so its sum is the sum of the figures the steps quote. */
export function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** A chain's gas figures from the snapshot: per-action execution costs and the one-time Solana rent. A chain the snapshot does not cover has no figures at all — null, never a static estimate that looks measured. */
export interface ChainGas {
  approve: number | null;
  deposit: number | null;
  bridge: number | null;
  rent: number | null;
  measured: boolean;
}
export function gasForChain(chain: string): ChainGas {
  const key = GAS_CHAIN_KEY[chain.toLowerCase()];
  if (GAS_COSTS !== null && key !== undefined) {
    const c = GAS_COSTS.chains[key];
    if (c !== undefined && c.entry_usd !== null && c.execution_usd !== null) {
      return { approve: c.execution_usd.approve, deposit: c.execution_usd.deposit, bridge: c.execution_usd.bridge, rent: c.first_account_rent_usd, measured: true };
    }
  }
  return { approve: null, deposit: null, bridge: null, rent: null, measured: false };
}

/** "about $0.0047 of gas", or "under $0.0001 of gas" when the measured figure rounds to zero. */
function gasPhrase(n: number): string {
  return n > 0 ? `about ${fmtUsd(n)} of gas` : 'under $0.0001 of gas';
}

/** The L2 chains: only there does the execution-only gas figure also exclude the L1 data fee. */
const L2_CHAINS = new Set(['arbitrum', 'base', 'ink', 'linea', 'optimism', 'plasma', 'scroll']);

/** A measured gas figure's label: "excl. L1 data fee" belongs to L2 chains only. */
function gasLabel(chain: string, date: string): string {
  return L2_CHAINS.has(chain.toLowerCase())
    ? `estimate as of ${date}, execution only, excl. L1 data fee, bridge and slippage`
    : `estimate as of ${date}, execution only, excl. bridge and slippage`;
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

/** Which gas figure an action costs: a bridge when the category bridges, a deposit otherwise. The main action bridges exactly when the category does. */
function actionKindFor(p: SnapshotProtocol): 'deposit' | 'bridge' {
  const c = (p.category ?? '').toLowerCase();
  return c.includes('bridge') || c.includes('cross chain') ? 'bridge' : 'deposit';
}

/**
 * Verified points programs, from the canonical registry repo/data/points-programs.json
 * (built from the research file tools/points_programs.json, one entry per slug with its own
 * source link). The registry rule: a program counts as verified only when points is true AND
 * the source is the project's own domain (official_source) AND the check is within 30 days of
 * the build date. Anything absent from the registry, or failing the rule, is unknown, not "no".
 * The registry names the program in the farm plan's points-check step — it never changes a value.
 * Counts at the last check (2026-11-20): 16 total, 11 verified, 5 unknown (b14g, firelight,
 * veda, curvance, noble). BitFi Basis added 2026-11-20, verified through bfUSD only
 * (docs.bitfi.one/points-program/overview: "The BitFi Points Program is now live"); the same
 * page's bfBTC banner contradicts its bfBTC HODL section, so no bfBTC plan is written.
 * Noble Points (Season 2) ENDED April 2026 (Dollar v2.3.0 disabled vault locking; Noble
 * v11.4.0 unlocked all staked positions), so Noble is unknown with an ended-program plan:
 * no deposit, no delegation — holding USDC never earned points, and public delegation
 * does not exist on its permissioned proof-of-authority chain.
 * Two corrections vs early notes: Mezo "mats" ended January 2026 (MEZO is live)
 * and Plume Nest Points Season 1 ended 13 March 2026, so neither is listed. Re-verified
 * 2026-11-19 against each project's own domain (registry rule: official source only): b14g,
 * firelight and veda REMOVED — b14g has no official-domain proof the program is still live after
 * the 31 Oct 2026 exploit; Firelight Points ended with Phase 1 (eligibility fixed 6 Oct 2026, new
 * deposits earn cover premiums, not points); Veda has no Veda-run points season open per a 13 Nov
 * 2026 check and its own homepage no longer mentions points. Curvance REMOVED 2026-11-19 by
 * Hunter's decision (strict-evidence standard): its Bytes page is wallet-gated and JS-rendered,
 * so liveness could only be shown secondhand (a 29 Oct 2026 third-party reading) — the only one
 * whose liveness was not directly verifiable. Reversible if fresh official evidence appears
 * before 14 Dec 2026.
 */
export interface PointsProgramEntry {
  points: boolean;
  official_source: boolean;
  checked: string;
  source: string;
  program: string | null;
}
export interface PointsRegistry {
  meta: { total: number; yes: number; unknown: number; checked: string; rule: string };
  programs: Record<string, PointsProgramEntry>;
}
/** One slug's points verdict: verified only under the registry rule, else unknown. */
export interface PointsStatus {
  status: 'verified' | 'unknown';
  program: string | null;
  checked: string | null;
  source: string | null;
}

/** The committed registry, or null when the file is missing or unreadable. */
function loadPointsRegistry(): PointsRegistry | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(join(here, '..', 'data', 'points-programs.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.programs !== 'object' || o.programs === null || Array.isArray(o.programs)) return null;
    return parsed as PointsRegistry;
  } catch {
    return null;
  }
}
export const POINTS_REGISTRY: PointsRegistry | null = loadPointsRegistry();

/** Whether a registry check date is within 30 days before `now` (never a future date). */
function checkedWithin30Days(checked: string, now: Date): boolean {
  const at = Date.parse(`${checked}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  const diff = now.getTime() - at;
  return diff >= 0 && diff <= 30 * DAY_MS;
}

/** A registry string field, or null when it is absent or not a string. */
function registryString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One slug's points status under the registry rule: verified ⟺ points AND official_source AND
 * checked within 30 days of the run. Both pipeline runs happen on the same day, so the run-date
 * check keeps byte-identical output. A slug the registry does not carry, or a missing registry,
 * is unknown with null fields; a listed slug that fails the rule is unknown but still carries
 * its registry program (null for the 4 unknown), check date and source.
 */
export function pointsStatusFor(slug: string): PointsStatus {
  if (POINTS_REGISTRY === null) return { status: 'unknown', program: null, checked: null, source: null };
  const entry = POINTS_REGISTRY.programs[slug];
  if (entry === undefined) return { status: 'unknown', program: null, checked: null, source: null };
  const program = registryString(entry.program);
  const checked = registryString(entry.checked);
  const source = registryString(entry.source);
  const verified =
    entry.points === true &&
    entry.official_source === true &&
    checked !== null &&
    checkedWithin30Days(checked, new Date());
  return { status: verified ? 'verified' : 'unknown', program, checked, source };
}

/**
 * Why a board's points claims are not ones the gate will take, or null: no row may claim a
 * verified points program the registry does not verify for that slug.
 */
export function pointsIssue(board: BoardRow[]): string | null {
  for (const r of board) {
    if (r.points_status === 'verified' && pointsStatusFor(r.slug).status !== 'verified') {
      return `${r.slug} claims a verified points program but the registry does not verify it`;
    }
  }
  return null;
}

/**
 * A protocol's farm plan, in two outputs by points status. A verified program gets a full
 * farm plan (eleven steps; ten on a chain without token allowances, which has no approve
 * step); an unverified one gets a verification plan only (six steps) —
 * what to check, on which domain, and what would turn it into a yes or a no. The
 * verification plan never sizes or takes a deposit. Every claim the plan makes names its
 * source (the registry's program, domain and check date) or is labelled a hypothesis in
 * the step itself; no action is presented as counted points without evidence. The plan is
 * derived from the protocol's own record (category, chains, TVL, age) plus its registry
 * status, never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, ps: PointsStatus): FarmStep[] {
  if (ps.status === 'unknown') return verificationSteps(p, ps);
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const gas = gasForChain(chain);
  const date = gasCostsDate();
  const program = ps.program ?? 'points program';
  const domain = domainOf(ps.source) ?? 'the protocol\u2019s own site';
  const checkedDay = fmtDay(ps.checked) ?? 'recently';
  // The cost figures are measured network fees, dated; the label says so on the step that
  // carries a gas number, and names what the figure leaves out. "Excl. L1 data fee" applies
  // to L2 chains only (see gasLabel); a non-L2 chain's label leaves it out. A chain the
  // snapshot does not cover carries no figure at all: its steps say the gas is unmeasured
  // and the total cannot be calculated.
  const label = gas.measured && date !== null ? gasLabel(chain, date) : 'gas unmeasured on this chain';
  const approve = gas.approve ?? 0;
  const deposit = gas.deposit ?? 0;
  const bridge = gas.bridge ?? 0;
  const rent = gas.rent ?? 0;
  const kind = actionKindFor(p);
  const mainCost = kind === 'bridge' ? bridge : deposit;
  const secondCost = mainCost; // the second action bridges exactly when the first does
  // Saturn's plan differs from the generic one (research 20 Nov 2026, Etherscan evidence):
  // staking USDat into the sUSDat vault needs its own approval (the vault's deposit uses
  // transferFrom), so the plan has 4 approvals, not 2 — approve USDC, approve USDat, then
  // revoke both at the exit. The exit withdraws in two transactions (request the unstake,
  // then claim from the withdrawal queue), so 4 actions, not 3. BitFi Basis is likewise
  // slug-specific (docs.bitfi.one, bfUSD only): approve USDC, mint bfUSD, stake it, then
  // unstake and redeem at the exit — 2 approvals, 4 actions. The total step quotes the
  // same figures, so its sum is the sum of the figures the steps quote.
  // No weekly on-chain action is ever counted: no verified program names one that counts,
  // so holding is enough and the weekly step carries no gas for any row. Chains without
  // allowances have no approve step at all, so approveCount is 0 there and the exit
  // revokes nothing. The generic second step is a conditional check, not an action, so its
  // gas never enters the default total: a deposit row counts main + withdraw (2), a bridge
  // row counts its bridge (1) plus the withdraw (1).
  const isSaturn = p.slug === 'saturn';
  const isBitfi = p.slug === 'bitfi-basis';
  const isDoppler = p.slug === 'doppler-finance';
  const noAllowance = NO_ALLOWANCE_CHAINS.has(chain.toLowerCase());
  // Native fee for the one verified row whose chain the gas snapshot does not cover
  // (gas worker, verified 20 Nov 2026): XRPL burns 10 drops per standard transaction.
  // The full verified text is quoted in the total step; the other steps quote the short
  // form. Its total is not a measured USD sum — the cost field says so. (Noble's native
  // fee text was removed 2026-11-20: its program ended in April 2026, so Noble no longer
  // gets a farm plan at all.)
  const DOPPLER_FEE = 'XRPL tidak punya approve/allowance. Setiap transaksi standar membakar 10 drops (0,00001 XRP ≈ $0,00001 pada harga XRP $0,95, 20 Nov 2026) — fee dihancurkan, bukan dibayar ke siapa pun. Akun baru wajib didanai 1 XRP (base reserve, ≈ $0,95); tiap trust line di luar dua yang pertama menambah reserve 0,2 XRP (≈ $0,19). Sumber: xrpl.org/docs/concepts/transactions/transaction-cost dan /accounts/reserves.';
  const nativeCore = isDoppler
    ? '10 drops (≈ $0.00001) burned per transaction'
    : null;
  const nativeFee = nativeCore === null ? null : `${nativeCore}; no approve on XRPL`;
  const nativeWithdraw = nativeCore === null ? null : `${nativeCore} to withdraw`;
  const approveCount = isSaturn ? 4 : isBitfi ? 2 : noAllowance ? 0 : 2;
  const depCount = isSaturn ? 4 : isBitfi ? 4 : kind === 'deposit' ? 2 : 1; // main + withdraw; a bridge row counts the withdraw only
  const bridgeCount = isSaturn || isBitfi ? 0 : kind === 'bridge' ? 1 : 0; // the main bridge only
  const total = gas.measured ? approve * approveCount + deposit * depCount + bridge * bridgeCount + rent : null;
  const pctStr = total === null ? null : ((total / capital) * 100 >= 1 ? ((total / capital) * 100).toFixed(1) : ((total / capital) * 100).toFixed(2));
  const approveCost = gas.measured ? gasPhrase(approve) : 'gas unmeasured on this chain';
  const totalText = isDoppler
    ? `Week ${weeks}: Add up the plan's gas: ${DOPPLER_FEE} Each transaction costs under $0.01.`
      : gas.measured
        ? `Week ${weeks}: Add up the plan's gas: ${approveCount > 0 ? `${approveCount} approvals at ${gasPhrase(approve)} each and ` : ''}${depCount} action${depCount === 1 ? '' : 's'} at ${gasPhrase(deposit)} each${bridgeCount > 0 ? ` and ${bridgeCount} bridge${bridgeCount === 1 ? '' : 's'} at ${gasPhrase(bridge)} each` : ''}${gas.rent !== null ? `, plus a one-time token-account rent of ${fmtUsd(rent)}` : ''}.`
        : `Week ${weeks}: Add up the plan's gas: this chain's gas is unmeasured, so the plan's total gas cannot be calculated — do not guess a figure.`;
  const totalCost = isDoppler
    ? 'under $0.01 per transaction; total cannot be calculated precisely in USD'
      : gas.measured
        ? `${total !== null && total > 0 ? `about ${fmtUsd(total)}` : 'under $0.0001'} in total, about ${pctStr}% of the $${capital} deposit; ${label}`
        : 'gas unmeasured, total cannot be calculated';
  const action = isSaturn
    ? `Mint $${capital} of USDat with USDC through ${p.name} on ${chain}. Minting is permissioned: only onboarded (whitelisted) addresses can mint. Gas below assumes the same ~130k gas units as a standard deposit; not measured for minting.`
    : isBitfi
      ? `Mint $${capital} of bfUSD with USDC through ${p.name} on ${chain}. bfUSD is BitFi's own token, not Binance BFUSD. Gas below assumes the same ~130k gas units as a standard deposit; not measured for minting.`
      : actionFor(p, capital, chain);
  // Solana's one-time token-account rent is charged on the first transaction that receives
  // the token — now the main action, since there is no approve step on a chain without
  // allowances — so the rent is named here, in the main step's cost, and in the total step.
  const rentNote = noAllowance && gas.rent !== null ? ` Plus a one-time token-account rent of ${fmtUsd(rent)}.` : '';
  const mainCostText = gas.measured
    ? `$${capital} of capital and ${gasPhrase(mainCost)}${noAllowance && gas.rent !== null ? `, plus a one-time token-account rent of ${fmtUsd(rent)}` : ''}; ${label}`
    : nativeFee !== null
      ? `$${capital} of capital; ${nativeFee}`
      : `$${capital} of capital; gas unmeasured on this chain`;
  return [
    {
      text: isBitfi
        ? `Week 0: Open BitFi's own ${program} page on ${domain} (checked ${checkedDay}) and confirm the program is still listed. If the page no longer names the program, stop — do not deposit. Run this plan on one wallet only (fresh wallet, seed phrase kept offline) — never the same plan across many wallets. Connect only to view; sign nothing outside this plan's steps. BitFi is CeDeFi, custodied by Ceffu: counterparty risk applies. Its docs say bfBTC points ended, contradicting the bfBTC HODL section — this plan covers bfUSD only, never bfBTC.`
        : `Week 0: Open ${p.name}'s own ${program} page on ${domain} (checked ${checkedDay}) and confirm the program is still listed. If the page no longer names the program, stop — do not deposit. Run this plan on one wallet only (a fresh wallet, seed phrase kept offline) — never the same plan across many wallets. Connect the wallet only to view; sign nothing outside this plan's steps.${isSaturn ? ' The program page does not say what the points convert to — not yet known.' : ''}`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    ...(noAllowance
      ? []
      : [
          {
            text: `Week 1: Approve exactly $${capital} of USDC for ${p.name} on ${chain} — the deposit amount only, never an unlimited allowance.`,
            cost: approveCost,
            time: '5 minutes',
          },
        ]),
    {
      text: `Week 1: ${action}${rentNote} The $${capital} is a suggested starting size, not a rule: size it from your own budget and conviction — the protocol's TVL does not set your deposit.`,
      cost: mainCostText,
      time: '15 minutes to set up',
    },
    {
      text: isSaturn
        ? `Week 1: Approve exactly $${capital} of USDat for the sUSDat vault (the stake amount only, never unlimited), then stake it. The contracts also offer depositWithPermit, but its use in the app is unverified, so this plan budgets the approval. Gas quoted at the mint's unit figure; the real cost can be higher.`
        : isBitfi
          ? `Week 1: Stake $${capital} of bfUSD to Horizon or Pulsar (the First Stake quest, one time only). Providing $${capital} of bfUSD as Curve liquidity is the alternative First Provide quest, not a second step. Gas quoted at the mint's unit figure; the real cost can be higher.`
          : `Week 1: Check the program's own rules for a second action that counts. If the rules name one, take it (same unit gas figure as the main action); if they name none, skip this step.`,
      cost: gas.measured
        ? isSaturn
          ? `${gasPhrase(approve)} to approve, ${gasPhrase(secondCost)} to stake`
          : isBitfi
            ? gasPhrase(secondCost)
            : `no gas by default; ${gasPhrase(secondCost)} if a second counted action is named`
        : isSaturn || isBitfi
          ? 'gas unmeasured on this chain'
          : nativeCore !== null
            ? `no gas by default; ${nativeCore} if a second counted action is named`
            : 'no gas by default; gas unmeasured on this chain if a second counted action is named',
      time: '10 minutes',
    },
    {
      text: `Weeks 2–${weeks}: No weekly on-chain action is needed: the program names none that counts, so holding is enough. Each week open the program page, check TVL and incidents, and exit if a gate condition is met.`,
      cost: gas.measured || nativeFee !== null ? 'no gas by default' : 'gas unmeasured on this chain',
      time: '10 minutes a week',
    },
    {
      text: `Weeks 1–${weeks}: Hold the position for at least ${hold} days. Hypothesis: the program does not publish a snapshot schedule, so a longer hold is a guess at being counted, not a guarantee.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Week ${weeks}: Open ${p.name}'s own ${program} page on ${domain} again and check the program is still live (last checked ${checkedDay}). If it has ended, exit at the next step instead of extending the hold.`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: isSaturn
        ? `Week ${weeks}: Exit gate — revoke both approvals on ${chain}: the USDC approval for ${p.name} and the USDat approval for the sUSDat vault. Withdraw in two transactions: request the unstake, then claim from the withdrawal queue when ready (both at the mint's unit gas figure). Withdraw early, even at a loss, if a pegged asset depegs, a security incident occurs, or the points program ends or changes status.`
        : isBitfi
          ? `Week ${weeks}: Exit gate — revoke the USDC approval for ${p.name} on ${chain}. Unstake from Horizon or Pulsar, then redeem the bfUSD. Withdraw early, even at a loss, if a pegged asset depegs, a security incident occurs, or the points program ends or changes status.`
          : noAllowance
            ? `Week ${weeks}: Exit gate — withdraw the position. Withdraw early, even at a loss, if a pegged asset depegs, the protocol reports a security incident, or the points program ends or changes status.`
            : `Week ${weeks}: Exit gate — revoke the ${p.name} approval on ${chain} and withdraw the position. Withdraw early, even at a loss, if a pegged asset depegs, the protocol reports a security incident, or the points program ends or changes status.`,
      cost: gas.measured
        ? isSaturn
          ? `${gasPhrase(approve)} to revoke each approval and ${gasPhrase(deposit)} per withdrawal (2 approvals, 2 withdrawals)`
          : isBitfi
            ? `${gasPhrase(approve)} to revoke the approval and ${gasPhrase(deposit)} per withdrawal (1 approval, 2 withdrawals)`
            : noAllowance
              ? `${gasPhrase(deposit)} to withdraw`
              : `${gasPhrase(approve)} to revoke the approval and ${gasPhrase(deposit)} to withdraw`
        : nativeWithdraw !== null
          ? nativeWithdraw
          : 'gas unmeasured on this chain',
      time: '15 minutes',
    },
    {
      text: isBitfi
        ? `Week ${weeks}: Claim only from the link ${p.name} itself publishes on its own site, and never pay anyone to claim for you. ${p.name}'s docs say token airdrops will be distributed from total points, but when and how is not yet known — if no claim link is published, there is nothing to claim yet.`
        : `Week ${weeks}: Claim only from the link the protocol itself publishes on its own site, and never pay anyone to claim for you. If no claim link is published, there is nothing to claim yet.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: totalText,
      cost: totalCost,
      time: '5 minutes',
    },
    {
      text: `Throughout: Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The verification plan for a protocol with no verified points program: checks only, no deposit. */
function verificationSteps(p: SnapshotProtocol, ps: PointsStatus): FarmStep[] {
  const checkedDay = fmtDay(ps.checked);
  // Noble is the one ended program on record (research 20 Nov 2026, Dollar v2.3.0 + Noble
  // v11.4.0): Season 2 ended in April 2026, so the plan says so outright instead of the
  // generic "found no program" — and warns holders about Circle's 12 Jan 2027 USDC pause.
  const isNoble = p.slug === 'noble';
  const first = isNoble
    ? `Week 0: Do not deposit. Noble Points (Season 2) ended in April 2026 — Dollar v2.3.0 disabled vault locking and the v11.4.0 upgrade unlocked all staked vault positions — and points.noble.xyz no longer names any points program (checked ${checkedDay}). The only historical points action was locking USDN in the USDN Staking Vault, forfeiting yield for points; holding USDC on Noble never earned points, and ordinary users cannot delegate on Noble's permissioned proof-of-authority validator set.`
    : checkedDay !== null
      ? `Week 0: The registry last checked ${p.name} on ${checkedDay} and found no points program on the protocol's own domain, so there is no farm plan here — only checks. Start again from ${p.name}'s page on DefiLlama (slug ${p.slug}) and follow its official-site link; an off-domain mention proves nothing.`
      : `Week 0: No points program is on record for ${p.name}, so there is no farm plan here — only checks. Start from ${p.name}'s page on DefiLlama (slug ${p.slug}) and follow its official-site link; do not deposit on the strength of a rumour.`;
  return [
    {
      text: first,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: isNoble
        ? `Week 0: Check Noble's official channels for any successor program on the new EVM L1; until one is published with rules, there is nothing to farm here. If you already hold USDC on Noble, move it off before Circle pauses the Noble USDC contract on 12 Jan 2027. Do not connect your wallet or sign anything to view a points page.`
        : `Week 0: On the protocol's own site, look for a points or rewards page and read what it actually promises — the program's name, its season and which actions it counts. Do not connect your wallet or sign anything to view the points page. If there is no such page, stop here.`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Week 0: Check the program's own page for an end date or a fixed eligibility date: a season that has ended, or eligibility that is already fixed, pays no new activity.`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Week 0: What turns this into a yes: the program is listed on the protocol's own domain, with a named season and named actions — then a fresh registry check must confirm it before any deposit.`,
      cost: 'no fee to check',
      time: '5 minutes',
    },
    {
      text: `Week 0: What turns this into a no: no program on the official site, a program the official site says has ended, or a program only an aggregator mentions.`,
      cost: 'no fee to check',
      time: '5 minutes',
    },
    {
      text: `Throughout: Write the date and what each page said in a verification log, so the check can be repeated and the registry re-checked after 30 days.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/**
 * The farm verdict (research/farm-verdicts.md): one verdict per board row, from the model's
 * economics — FARM / MARGINAL-THIN / SKIP. This is NOT a recommendation to deposit. For a
 * verified row the verdict rests on a real points program and a costed plan; for an unknown
 * row it is conditional — what WOULD pay IF the program verifies AND the token launches —
 * and the row's verification plan still says: verify first, deposit nothing until then.
 *
 *   slice  = implied_if_launches x odds x DROP_SHARE x deposit / (TVL + deposit)
 *   fees   = the farm plan's total gas when measured, else 0 (flagged unmeasured)
 *   tbill  = deposit x TBILL_RATE x hold_days / 365
 *   net    = slice - fees - tbill
 *   hours  = (SETUP_MINUTES + WEEKLY_MINUTES x weeks) / 60, weeks = ceil(hold_days / 7)
 *   FARM ⟺ net > $25 AND net/hour > $5; MARGINAL-THIN ⟺ net > $0; else SKIP.
 *
 * The slice is the farmer's PRO-RATA share of the farmer allocation, not the whole
 * allocation: DROP_SHARE (5% of launch FDV) is what ALL farmers share, and one deposit
 * earns its deposit/(TVL + deposit) share of it — the top-10 formula (research/
 * top10-references.md P4: slice = drop share x implied x deposit / (TVL + deposit)).
 * Reading the task's shorthand "slice = implied x odds x drop_share" literally would hand
 * the entire farmer pool to one $50-$250 deposit and make all 197 rows FARM; the pro-rata
 * factor is what makes the verdict discriminate at all (21 FARM / 170 MARGINAL-THIN /
 * 6 SKIP on this snapshot). The 5% itself is a stated assumption, not a measurement: the
 * top 10 use 3.5-14% (kiencx/europa 7%); 5% sits in the middle and is conservative
 * against their 7%. The 4% T-bill rate is theirs too (kiencx: "the same money in a 4%
 * T-bill"). Deposit and hold reuse the farm plan's own sizing (capitalFor / holdDaysFor),
 * so a verdict and its plan never disagree about the ticket or the horizon. Hours reuse
 * the plan's own time budget: 80 setup minutes (10 check + 5 approve + 15 main action +
 * 10 second action + 10 re-check + 15 exit + 10 claim + 5 total) plus 10 minutes a week
 * of checks while holding.
 *
 * What the verdict does NOT know: whether the points program exists (unknown rows),
 * whether the token ever launches (odds are the peers' record, not a forecast), the
 * drop's vesting or claim conditions, slippage, or the deposit's own risk (depeg,
 * exploit, custody). A FARM verdict on an unknown row is a statement about the model's
 * arithmetic, not about a program.
 */
export const VERDICT_DROP_SHARE = 0.05;
export const VERDICT_TBILL_ANNUAL_RATE = 0.04;
export const VERDICT_FARM_NET_USD = 25;
export const VERDICT_FARM_NET_PER_HOUR_USD = 5;
export const VERDICT_SETUP_MINUTES = 80;
export const VERDICT_WEEKLY_MINUTES = 10;

export type FarmVerdict = 'FARM' | 'MARGINAL-THIN' | 'SKIP';
export interface VerdictDetail {
  verdict: FarmVerdict;
  slice_usd: number;
  fees_usd: number;
  fees_measured: boolean;
  tbill_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
  hours: number;
  deposit_usd: number;
  hold_days: number;
  /** 'verified': a real program and a costed plan behind the verdict. 'conditional': unknown row — profitable only IF verified + launches. */
  basis: 'verified' | 'conditional';
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A farm plan's total gas in USD, as a number — the same counts farmSteps() quotes in its
 * total step (approveCount / depCount / bridgeCount, plus the Solana one-time rent), so the
 * verdict's fees and the plan's total step can never drift apart; the validation script
 * cross-checks them. Null when the plan has no measured total: an unknown row (its plan is
 * verification only, no deposit) or a verified row on a chain the gas snapshot does not
 * cover. Doppler (XRPL) is the one exception with a number but no measurement: XRPL burns
 * 10 drops per standard transaction, so ~7 transactions cost ~$0.00007 — quoted as $0.0001,
 * flagged unmeasured, because it is an arithmetic bound, not a measured USD sum.
 */
export function farmPlanGasUsd(p: SnapshotProtocol, ps: PointsStatus): { gas_usd: number | null; measured: boolean } {
  if (ps.status !== 'verified') return { gas_usd: null, measured: false };
  if (p.slug === 'doppler-finance') return { gas_usd: 0.0001, measured: false };
  const chain = chainOf(p);
  const gas = gasForChain(chain);
  if (!gas.measured) return { gas_usd: null, measured: false };
  const kind = actionKindFor(p);
  const noAllowance = NO_ALLOWANCE_CHAINS.has(chain.toLowerCase());
  const isSaturn = p.slug === 'saturn';
  const isBitfi = p.slug === 'bitfi-basis';
  const approveCount = isSaturn ? 4 : isBitfi ? 2 : noAllowance ? 0 : 2;
  const depCount = isSaturn ? 4 : isBitfi ? 4 : kind === 'deposit' ? 2 : 1;
  const bridgeCount = isSaturn || isBitfi ? 0 : kind === 'bridge' ? 1 : 0;
  const total = (gas.approve ?? 0) * approveCount + (gas.deposit ?? 0) * depCount + (gas.bridge ?? 0) * bridgeCount + (gas.rent ?? 0);
  return { gas_usd: total, measured: true };
}

/** One row's farm verdict from the model's economics. */
export function farmVerdictFor(p: SnapshotProtocol, age: number | null, ps: PointsStatus, impliedIfLaunches: number, odds: number): VerdictDetail {
  const deposit = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const hours = (VERDICT_SETUP_MINUTES + VERDICT_WEEKLY_MINUTES * weeks) / 60;
  const slice = impliedIfLaunches * odds * VERDICT_DROP_SHARE * (deposit / (p.tvl_usd + deposit));
  const gas = farmPlanGasUsd(p, ps);
  const fees = gas.gas_usd ?? 0;
  const tbill = deposit * VERDICT_TBILL_ANNUAL_RATE * (hold / 365);
  const net = slice - fees - tbill;
  const netPerHour = net / hours;
  const verdict: FarmVerdict = net > VERDICT_FARM_NET_USD && netPerHour > VERDICT_FARM_NET_PER_HOUR_USD ? 'FARM' : net > 0 ? 'MARGINAL-THIN' : 'SKIP';
  return {
    verdict,
    slice_usd: round2(slice),
    fees_usd: round4(fees),
    fees_measured: gas.measured,
    tbill_usd: round2(tbill),
    net_usd: round2(net),
    net_per_hour_usd: round2(netPerHour),
    hours: round2(hours),
    deposit_usd: deposit,
    hold_days: hold,
    basis: ps.status === 'verified' ? 'verified' : 'conditional',
  };
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

/** The 2-3 nearest live-token protocols by TVL, same category first.
 *
 * A peer must already record a token with a market cap (that is what "priced" means here)
 * and a positive TVL. Same-category peers come first, then other categories, each ordered
 * by |ln(TVL) difference| — the closest in size. Versioned pools (aave-v3), wrapped/staked
 * names and exchanges are excluded from the first pass: a version row's market cap is its
 * parent token's, not the version's, so its multiple is distorted (research/token-odds-model
 * §1.1); if fewer than 2 clean peers exist the second pass relaxes the name rules rather
 * than leaving the row with one peer. The multiple shown is market cap / TVL — the snapshot
 * carries no FDV, so no FDV/TVL multiple can be shown for a peer.
 */
export function nearestPeersFor(p: SnapshotProtocol, snapshot: Snapshot): NearestPeer[] {
  const clean = (q: SnapshotProtocol): boolean =>
    q.slug !== p.slug &&
    q.symbol !== null &&
    q.mcap_usd !== null &&
    q.tvl_usd > 0 &&
    q.category !== 'CEX' &&
    !VERSIONED.test(q.name) &&
    !WRAPPED_WORD.test(q.name) &&
    !ST_TOKEN.test(q.name) &&
    !EXCHANGE_PREFIX.test(q.name);
  const byDistance = (a: SnapshotProtocol, b: SnapshotProtocol): number => {
    const sameA = a.category === p.category ? 0 : 1;
    const sameB = b.category === p.category ? 0 : 1;
    if (sameA !== sameB) return sameA - sameB;
    return Math.abs(Math.log(a.tvl_usd) - Math.log(p.tvl_usd)) - Math.abs(Math.log(b.tvl_usd) - Math.log(p.tvl_usd));
  };
  const toPeer = (q: SnapshotProtocol): NearestPeer => ({
    slug: q.slug,
    name: q.name,
    category: q.category,
    tvl_usd: q.tvl_usd,
    mcap_usd: q.mcap_usd!,
    mcap_multiple: round3(q.mcap_usd! / q.tvl_usd),
  });
  const peers = snapshot.protocols.filter(clean).sort(byDistance).slice(0, 3).map(toPeer);
  if (peers.length < 2) {
    const fallback = snapshot.protocols
      .filter((q) => q.slug !== p.slug && q.symbol !== null && q.mcap_usd !== null && q.tvl_usd > 0 && !peers.some((r) => r.slug === q.slug))
      .sort((a, b) => Math.abs(Math.log(a.tvl_usd) - Math.log(p.tvl_usd)) - Math.abs(Math.log(b.tvl_usd) - Math.log(p.tvl_usd)));
    for (const q of fallback) {
      if (peers.length >= 3) break;
      peers.push(toPeer(q));
    }
  }
  return peers;
}

/** The protocol ledger: every snapshot protocol in exactly one bucket (see the Ledger interface). */
export function buildLedger(snapshot: Snapshot, board: BoardRow[]): Ledger {
  const boardSlugs = new Set(board.map((r) => r.slug));
  const liveSlugs = new Set(liveRows(snapshot).map((r) => r.slug));
  const empty = (): LedgerBucket => ({ count: 0, tvl_usd: 0 });
  const ledger: Ledger = {
    total: snapshot.protocols.length,
    ranked: empty(),
    live_token_shown: empty(),
    live_token_other: empty(),
    excluded_category: empty(),
    excluded_category_by_category: {},
    versioned: empty(),
    wrapped_or_staked: empty(),
    exchange_name: empty(),
    other_excluded: empty(),
  };
  const add = (bucket: LedgerBucket, p: SnapshotProtocol): void => {
    bucket.count += 1;
    bucket.tvl_usd += p.tvl_usd;
  };
  const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  for (const p of snapshot.protocols) {
    if (boardSlugs.has(p.slug)) {
      add(ledger.ranked, p);
    } else if (!isPreToken(p)) {
      add(liveSlugs.has(p.slug) ? ledger.live_token_shown : ledger.live_token_other, p);
    } else if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
      add(ledger.excluded_category, p);
      ledger.excluded_category_by_category[p.category] = (ledger.excluded_category_by_category[p.category] ?? 0) + 1;
    } else if (isVersionedPool(p, snapshotSlugs)) {
      add(ledger.versioned, p);
    } else if (isWrappedOrStakedName(p)) {
      add(ledger.wrapped_or_staked, p);
    } else if (EXCHANGE_PREFIX.test(p.name)) {
      add(ledger.exchange_name, p);
    } else {
      add(ledger.other_excluded, p);
    }
  }
  return ledger;
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
    implied_if_launches_usd: row.implied_if_launches_usd,
    token_odds: row.token_odds,
    farm_verdict: row.farm_verdict,
    verdict_net_usd: row.verdict_net_usd,
    verdict_net_per_hour_usd: row.verdict_net_per_hour_usd,
    verdict_slice_usd: row.verdict_slice_usd,
    verdict_fees_usd: row.verdict_fees_usd,
    verdict_fees_measured: row.verdict_fees_measured,
    verdict_tbill_usd: row.verdict_tbill_usd,
    verdict_basis: row.verdict_basis,
    value_parts: row.value_parts,
    nearest_peers: row.nearest_peers,
    multiple: row.model.multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    points_status: row.points_status,
    points_program: row.points_program,
    points_checked: row.points_checked,
    points_source: row.points_source,
    token_verification: row.token_verification,
    verified_token_symbol: row.verified_token_symbol,
    verification_source: row.verification_source,
    duplicate_of: row.duplicate_of,
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
    odds_evidence: ODDS_EVIDENCE,
    verdict_params: {
      drop_share: VERDICT_DROP_SHARE,
      tbill_annual_rate: VERDICT_TBILL_ANNUAL_RATE,
      farm_net_usd: VERDICT_FARM_NET_USD,
      farm_net_per_hour_usd: VERDICT_FARM_NET_PER_HOUR_USD,
    },
    ledger: buildLedger(snapshot, board),
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
