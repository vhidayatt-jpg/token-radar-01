// Token Radar's dashboard (radar-2). It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail drawer with the model's own
// inputs and the protocol's farm plan, and the calibration table the multiples come from.
// No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(m) {
    return (Math.round(m * 100) / 100) + 'x';
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  // implied = tvl x multiple(category) x growthMult x maturityMult.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, row.multiple));
    return Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturity));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. The one lookup by name is the
  // points-check step, which names a verified live points program when one is known (same table as
  // lib/model.ts POINTS_PROGRAMS, checked 2026-11-19); anything absent stays generic.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  // The gas-cost snapshot: the same timestamped measurement lib/model.ts reads at build
  // time (repo/data/gas-costs.json, from farm_plan.action_costs_usd()), embedded in
  // data.js as DATA.gas_costs so the page quotes the same numbers board.json carries.
  // Execution only: L2 figures exclude the L1 data fee, Solana figures exclude the
  // one-time token-account rent (shown separately in the farm plan). A chain the
  // snapshot does not cover keeps the old static estimate, marked as unmeasured.
  // Limit, stated in the plan: the Solana priority fee is the p75 of network-wide
  // getRecentPrioritizationFees (no account list), so it can understate contention
  // on hot DeFi accounts.
  var GAS_COSTS = DATA.gas_costs || null;
  var GAS_CHAIN_KEY = { ethereum: 'ethereum', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', linea: 'linea', scroll: 'scroll', binance: 'bsc', 'bnb chain': 'bsc', avalanche: 'avax', solana: 'solana' };
  function gasCostsDate() {
    if (!GAS_COSTS || !GAS_COSTS.as_of) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(GAS_COSTS.as_of);
    if (!m) return null;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
  }
  function fmtUsd(n) {
    if (n >= 0.1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    return '$' + n.toFixed(4);
  }
  function staticGasUsd(chain) {
    var c = (chain || '').toLowerCase();
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
    return 0.2;
  }
  function gasForChain(chain) {
    var key = GAS_CHAIN_KEY[(chain || '').toLowerCase()];
    if (GAS_COSTS && key) {
      var c = GAS_COSTS.chains[key];
      if (c && c.entry_usd !== null && c.entry_usd !== undefined && c.execution_usd) {
        return { entry: c.entry_usd, exec: c.execution_usd.deposit, rent: c.first_account_rent_usd, measured: true };
      }
    }
    var s = staticGasUsd(chain);
    return { entry: s, exec: s, rent: null, measured: false };
  }
  function gasPhrase(n) { return n > 0 ? 'about ' + fmtUsd(n) + ' of gas' : 'under $0.0001 of gas'; }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('risk curator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' of USDC into a ' + name + '-curated vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('restak') >= 0 && c.indexOf('liquid') >= 0) return 'Mint $' + capital + ' of the liquid restaking token through ' + name + ' on ' + chain + ' and hold it.';
    if (c.indexOf('restak') >= 0) return 'Restake $' + capital + ' of ETH or LST collateral through ' + name + ' on ' + chain + ' and keep the position.';
    if (c.indexOf('liquid staking') >= 0) return 'Stake $' + capital + ' of the chain asset through ' + name + ' on ' + chain + ' and hold the receipt token.';
    if (c.indexOf('staking pool') >= 0) return "Pool $" + capital + " of the chain asset in " + name + "'s staking pool on " + chain + ' and keep the receipt.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Deposit $' + capital + ' of USDC into ' + name + "'s main yield vault on " + chain + ' and keep the shares.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield-bearing real-world asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('basis') >= 0) return 'Deposit $' + capital + " of USDC into " + name + "'s synthetic-dollar vault on " + chain + ' and stake the receipt.';
    if (c.indexOf('payment') >= 0) return 'Open a $' + capital + ' payment channel through ' + name + ' on ' + chain + ' and route one payment a week.';
    if (c.indexOf('governance') >= 0) return 'Lock $' + capital + ' of the governance asset through ' + name + ' on ' + chain + ' and vote once.';
    if (c.indexOf('chain') >= 0) return 'Stake $' + capital + ' of the chain asset through ' + name + ' on ' + chain + ' and keep the delegation.';
    if (c.indexOf('cede') >= 0) return 'Deposit $' + capital + " of USDC into " + name + "'s custodial yield product on " + chain + ' and keep the balance.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function secondActionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('risk curator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Add a second deposit to another ' + name + '-curated vault on ' + chain + ', in a different asset.';
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0) return 'Delegate a second stake through ' + name + ' on ' + chain + ' to a different operator or validator.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Borrow a small amount against the supplied collateral on ' + name + ' and repay it the same week.';
    if (c.indexOf('dex') >= 0) return 'Swap a small amount through ' + name + "'s router on " + chain + ' once a week.';
    if (c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return "Claim the vault's yield on " + name + ' once and redeposit it instead of withdrawing.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge a second, smaller amount back through ' + name + ' so both directions are used.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Close the hedge on ' + name + ' and open a fresh one, so the account shows two settled trades.';
    if (c.indexOf('prediction') >= 0) return 'Settle one market on ' + name + ' and place a second position in a different market.';
    if (c.indexOf('stable') >= 0 || c.indexOf('basis') >= 0) return 'Stake the receipt token from ' + name + ' into its yield vault on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Hold the minted asset for one full distribution cycle on ' + name + ' before moving it.';
    if (c.indexOf('insurance') >= 0) return 'Renew the cover on ' + name + ' once so the policy spans two periods.';
    if (c.indexOf('payment') >= 0) return 'Send a second payment through the same ' + name + ' channel on ' + chain + '.';
    if (c.indexOf('governance') >= 0) return 'Vote on a second proposal through ' + name + ' on ' + chain + '.';
    if (c.indexOf('chain') >= 0) return 'Delegate to a second validator through ' + name + ' on ' + chain + '.';
    return 'Use ' + name + "'s app on " + chain + ' a second time, in a different feature than the first deposit.';
  }
  function pointsFor(p) {
    var c = (p.category || '').toLowerCase();
    if (c.indexOf('risk curator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'vault deposits and how long they stay in ' + p.name + "'s curated vaults";
    if (c.indexOf('restak') >= 0) return 'restaked collateral and the operators it is delegated to';
    if (c.indexOf('staking') >= 0 || c.indexOf('liquid staking') >= 0) return 'staked assets and the time they stay staked';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0) return 'supplied collateral, borrows and the time both stay open';
    if (c.indexOf('dex') >= 0) return 'liquidity provided and swaps routed through the pools';
    if (c.indexOf('yield') >= 0) return 'vault shares held and the yield claimed and redeposited';
    if (c.indexOf('bridge') >= 0) return 'volume bridged in both directions';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'margin deposited and trades settled';
    if (c.indexOf('prediction') >= 0) return 'positions placed and markets settled';
    if (c.indexOf('stable') >= 0 || c.indexOf('basis') >= 0) return 'stable assets minted and staked receipts held';
    if (c.indexOf('rwa') >= 0) return 'real-world assets minted and held through a distribution';
    if (c.indexOf('insurance') >= 0) return 'cover bought and the time the policy stays active';
    if (c.indexOf('payment') >= 0) return 'payments routed through the channel';
    if (c.indexOf('governance') >= 0) return 'assets locked and votes cast';
    if (c.indexOf('chain') >= 0) return "assets staked and the delegation's age";
    return 'deposits made and the time they stay in the protocol';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  // Verified points programs, checked 2026-11-19 (same table as lib/model.ts POINTS_PROGRAMS).
  // Only live programs are listed; absent means unknown, not "no". Names the program in the
  // points-check step; it never changes a value. Re-verified 2026-11-19: b14g, firelight
  // and veda removed (no official-domain proof of a live program); curvance removed by
  // Hunter's decision the same day (Bytes page is wallet-gated and JS-rendered, so its
  // liveness could only be shown secondhand). 11 programs remain.
  var POINTS_PROGRAMS = {
    'symbiotic': 'Symbiotic Points',
    'infinifi': 'Season 3 points',
    'yuzu-money': 'Yuzu Juice',
    'onre': 'OnRe Points',
    'upshift': 'Upshift Points (Season 2)',
    'axis': 'Coordinates (Season 1)',
    'tori-finance': 'Cores (Season 1)',
    'doppler-finance': 'Doppler Points (Season 3)',
    'noble': 'Noble Points (Season 2)',
    'saturn': 'Orbital Points (Season 2)',
    'tydro': 'TydroInkPoints (Season 2)'
  };
  function pointsStep(p) {
    var program = POINTS_PROGRAMS[p.slug];
    if (program) return "Open " + p.name + "'s own " + program + ' page and check that ' + pointsFor(p) + ' are being counted.';
    return "Open " + p.name + "'s own points or rewards page and check that " + pointsFor(p) + ' are being counted.';
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasForChain(chain);
    var date = gasCostsDate();
    var label = gas.measured && date !== null
      ? 'estimate as of ' + date + ', execution only, excl. L1 data fee, bridge and slippage'
      : 'static estimate, not measured';
    var entryPhrase = gas.entry !== null && gas.entry !== undefined ? gasPhrase(gas.entry) : 'about $0.20 of gas';
    var execPhrase = gas.exec !== null && gas.exec !== undefined ? gasPhrase(gas.exec) : 'about $0.20 of gas';
    var firstCost = gas.rent !== null && gas.rent !== undefined && gas.entry !== null && gas.entry !== undefined && gas.exec !== null && gas.exec !== undefined
      ? 'about ' + fmtUsd(gas.entry) + ' for the first transaction on ' + chain + ' (a one-time token-account rent of ' + fmtUsd(gas.rent) + ', plus ' + gasPhrase(gas.exec) + ')'
      : entryPhrase + ' for the first transaction on ' + chain + (gas.measured ? '' : ' (static estimate)');
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: firstCost, time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and ' + execPhrase + '; ' + label, time: '15 minutes to set up' },
      { text: secondActionFor(p, capital, chain), cost: gas.measured ? execPhrase : execPhrase + ' (static estimate)', time: '10 minutes' },
      { text: 'Make one qualifying action each week on ' + chain + ', such as a deposit, a swap, a vote or a claim.', cost: gas.measured ? execPhrase + ' a week' : execPhrase + ' a week (static estimate)', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: pointsStep(p), cost: 'no fee to check', time: '10 minutes' },
      { text: 'Before you withdraw, claim only from the link the protocol itself publishes, and never pay anyone to claim for you.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.selected) params.set('p', state.selected);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }),
        el('span', { class: 'brand-name' }, 'Token Radar', el('small', { text: 'Pre-token protocol index' }))),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, DATA.watchlist_size + ' watchlist protocols, ', el('em', { text: 'ranked by implied value' })),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is the estimated fully-diluted value of the token at launch, from the snapshot figures and a per-category launch multiple. It is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function calibrationPanel() {
    var tbody = el('tbody');
    DATA.calibration.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num' }, el('b', { text: fmtMult(c.multiple) })),
        el('td', { class: 'num', text: c.launches > 0 ? String(c.launches) : '—' }),
        el('td', { text: c.basis })
      ));
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Where the multiples come from' }),
      el('p', { text: 'Each multiple is the geometric mean of FDV/TVL at launch across real token launches in that category (day-0 and day-7 after launch; TVL from DefiLlama, FDV from first price x max supply). Categories with no launch of their own use the closest measured category, or the global mean. No protocol name is special-cased.' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'calib' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', class: 'num', text: 'Launch multiple' }),
            el('th', { scope: 'col', class: 'num', text: 'Launches' }),
            el('th', { scope: 'col', text: 'Basis' })
          )),
          tbody
        )
      ),
      el('div', { class: 'note-row' }, el('p', { class: 'sub', text: 'Launches behind the table (15 app-token launches with a computable FDV/TVL): Jupiter, Aerodrome, Morpho, Kamino, Dolomite, EigenLayer, Renzo, ether.fi, Jito, Ethena, Hyperliquid, Drift, Zeta Markets, Wormhole, Usual. Excluded from calibration: chain tokens (Starknet, zkSync, Scroll, Blast, Celestia, Movement, Dymension — valued on ecosystem potential, not TVL), Seamless (~168x on $8M launch TVL, a micro-TVL outlier), and launches with no computable ratio (Puffer, Swell, LayerZero, Ondo, Maple/Syrup, Plume). Full per-launch figures are in the entry research file.' }))
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures and its category. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x MULTIPLE[category] x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )'
      ),
      el('ul', { class: 'method' },
        el('li', null, el('b', { text: 'MULTIPLE[category]: ' }), 'the geometric mean of FDV/TVL at launch across real launches in the category, winsorized to ' + m.multiple_floor + 'x-' + m.multiple_cap + 'x. The table above shows every value and how many launches back it.'),
        el('li', null, el('b', { text: 'Growth: ' }), 'seven-day TVL change from the snapshot, clamped so one hot week cannot carry a row.'),
        el('li', null, el('b', { text: 'Maturity: ' }), 'age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days.'),
        el('li', null, el('b', { text: 'Gas costs: ' }), gasCostsDate() ? 'the farm plan\u2019s per-action figures are measured network fees as of ' + gasCostsDate() + ' (execution only \u2014 they exclude L1 data fees, bridge fees and slippage; the Solana one-time token-account rent is listed separately in the plan).' : 'the farm plan\u2019s per-action figures are static estimates, not measured.'),
        el('li', null, el('b', { text: 'What the board will not rank: ' }), 'a wrapped, staked or bridged product of a token that already trades (WBTC is Bitcoin on Ethereum, a bridge moves a token that already trades), an exchange product, or a versioned pool. The watchlist\u2019s own exclusion rule is applied to every row, not just the watchlist.'),
        el('li', null, el('b', { text: 'What is not here: ' }), 'no fees, no revenue and no social signal, because the sealed snapshot carries none. The model says what the snapshot can support, and nothing else.')
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function calibBasisFor(row) {
    var found = null;
    DATA.calibration.forEach(function (c) { if (c.category === row.category) found = c; });
    if (found) return found;
    return { category: row.category || 'Other', multiple: DATA.global_multiple, launches: 0, basis: 'global mean across all launches' };
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var basis = calibBasisFor(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rank-tag', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Launch multiple (' + (row.category || 'Other') + ')' }), el('b', { class: 'num', text: fmtMult(row.multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num hl', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Multiple basis: ' + basis.basis + (basis.launches > 0 ? ' (' + basis.launches + ' launch' + (basis.launches === 1 ? '' : 'es') + ').' : '.') + ' Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(impliedOf(row, DATA.model)) + (impliedOf(row, DATA.model) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') {
      shell.appendChild(calibrationPanel());
      shell.appendChild(modelPanel());
    }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
