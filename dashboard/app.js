(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', points: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

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
  var VP = DATA.verdict_params, OE = DATA.odds_evidence;
  function vB(r) { return el('span', { class: r.farm_verdict === 'FARM' ? 'status' : 'status muted', text: r.farm_verdict === 'FARM' && r.verdict_basis !== 'verified' ? 'FARM—if verified+launches' : r.farm_verdict }); }
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * row.multiple * growthMult * maturity));
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

  // Same derivation main.ts writes to board.json.
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
  var GAS_COSTS = DATA.gas_costs || null;
  var GAS_CHAIN_KEY = { ethereum: 'ethereum', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', linea: 'linea', scroll: 'scroll', binance: 'bsc', 'bnb chain': 'bsc', avalanche: 'avax', solana: 'solana', ink: 'ink', plasma: 'plasma' };
  var NO_ALLOW = { solana: 1, ripple: 1, xrpl: 1, noble: 1, cosmos: 1 };
  function gasCostsDate() {
    if (!GAS_COSTS || !GAS_COSTS.as_of) return null;
    return fmtDay(GAS_COSTS.as_of);
  }
  function fmtDay(iso) {
    if (iso === null || iso === undefined) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
  }
  function domainOf(source) {
    if (source === null || source === undefined) return null;
    var parts = source.split('/');
    return parts.length > 2 && parts[2] !== '' ? parts[2] : null;
  }
  function fmtGasUsd(n) { return '$' + n.toFixed(4); }
  function gasForChain(chain) {
    var key = GAS_CHAIN_KEY[(chain || '').toLowerCase()];
    if (GAS_COSTS && key) {
      var c = GAS_COSTS.chains[key];
      if (c && c.entry_usd !== null && c.entry_usd !== undefined && c.execution_usd) {
        return { approve: c.execution_usd.approve, deposit: c.execution_usd.deposit, bridge: c.execution_usd.bridge, rent: c.first_account_rent_usd, measured: true };
      }
    }
    return { approve: null, deposit: null, bridge: null, rent: null, measured: false };
  }
  function gasPhrase(n) { return n > 0 ? 'about ' + fmtGasUsd(n) + ' of gas' : 'under $0.0001 of gas'; }
  var L2_CHAINS = new Set(['arbitrum', 'base', 'ink', 'linea', 'optimism', 'plasma', 'scroll']);
  function gasLabel(chain, date) {
    return L2_CHAINS.has(chain.toLowerCase())
      ? 'estimate as of ' + date + ', execution only, excl. L1 data fee, bridge and slippage'
      : 'estimate as of ' + date + ', execution only, excl. bridge and slippage';
  }
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
  function actionKindFor(p) {
    var c = (p.category || '').toLowerCase();
    return c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0 ? 'bridge' : 'deposit';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var ps = { status: p.points_status, program: p.points_program, checked: p.points_checked, source: p.points_source };
    if (ps.status === 'unknown') return verificationSteps(p, ps);
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var weeks = Math.ceil(hold / 7);
    var gas = gasForChain(chain);
    var date = gasCostsDate();
    var program = ps.program || 'points program';
    var domain = domainOf(ps.source) || 'the protocol\u2019s own site';
    var checkedDay = fmtDay(ps.checked) || 'recently';
    var label = gas.measured && date !== null ? gasLabel(chain, date) : 'gas unmeasured on this chain';
    var approve = gas.approve === null || gas.approve === undefined ? 0 : gas.approve;
    var deposit = gas.deposit === null || gas.deposit === undefined ? 0 : gas.deposit;
    var bridge = gas.bridge === null || gas.bridge === undefined ? 0 : gas.bridge;
    var rent = gas.rent === null || gas.rent === undefined ? 0 : gas.rent;
    var kind = actionKindFor(p);
    var mainCost = kind === 'bridge' ? bridge : deposit;
    var secondCost = mainCost;
    // Saturn: 4 approvals, 4 actions; BitFi: 2 approvals, 4 actions.
    var sat = p.slug === 'saturn';
    var bit = p.slug === 'bitfi-basis';
    var dop = p.slug === 'doppler-finance';
    // XRPL fee (not in gas snapshot), verified 20 Nov 2026.
    var nc = dop ? '10 drops (≈ $0.00001) burned per transaction' : null;
    var DF = 'XRPL tidak punya approve/allowance. Setiap transaksi standar membakar 10 drops (0,00001 XRP ≈ $0,00001 pada harga XRP $0,95, 20 Nov 2026) — fee dihancurkan, bukan dibayar ke siapa pun. Akun baru wajib didanai 1 XRP (base reserve, ≈ $0,95); tiap trust line di luar dua yang pertama menambah reserve 0,2 XRP (≈ $0,19). Sumber: xrpl.org/docs/concepts/transactions/transaction-cost dan /accounts/reserves.';
    var noAllow = !!NO_ALLOW[chain.toLowerCase()];
    var approveCount = sat ? 4 : bit ? 2 : noAllow ? 0 : 2;
    var depCount = sat ? 4 : bit ? 4 : kind === 'deposit' ? 2 : 1; // main + withdraw
    var bridgeCount = sat || bit ? 0 : kind === 'bridge' ? 1 : 0;
    var total = gas.measured ? approve * approveCount + deposit * depCount + bridge * bridgeCount + rent : null;
    var pct = total === null ? null : (total / capital) * 100;
    var pctStr = pct === null ? null : pct >= 1 ? pct.toFixed(1) : pct.toFixed(2);
    var approveCost = gas.measured ? gasPhrase(approve) : 'gas unmeasured on this chain';
    var totalText = dop
      ? 'Week ' + weeks + ': Add up the plan\'s gas: ' + DF + ' Each transaction costs under $0.01.'
        : gas.measured
      ? 'Week ' + weeks + ': Add up the plan\'s gas: ' + (approveCount > 0 ? approveCount + ' approvals at ' + gasPhrase(approve) + ' each and ' : '') + depCount + ' action' + (depCount === 1 ? '' : 's') + ' at ' + gasPhrase(deposit) + ' each' + (bridgeCount > 0 ? ' and ' + bridgeCount + ' bridge' + (bridgeCount === 1 ? '' : 's') + ' at ' + gasPhrase(bridge) + ' each' : '') + (gas.rent !== null && gas.rent !== undefined ? ', plus a one-time token-account rent of ' + fmtGasUsd(rent) : '') + '.'
      : 'Week ' + weeks + ': Add up the plan\'s gas: this chain\'s gas is unmeasured, so the plan\'s total gas cannot be calculated — do not guess a figure.';
    var totalCost = dop
      ? 'under $0.01 per transaction; total cannot be calculated precisely in USD'
        : gas.measured
      ? (total !== null && total > 0 ? 'about ' + fmtGasUsd(total) : 'under $0.0001') + ' in total, about ' + pctStr + '% of the $' + capital + ' deposit; ' + label
      : 'gas unmeasured, total cannot be calculated';
    var action = sat
      ? 'Mint $' + capital + ' of USDat with USDC through ' + p.name + ' on ' + chain + '. Minting is permissioned: only onboarded (whitelisted) addresses can mint. Gas below assumes the same ~130k gas units as a standard deposit; not measured for minting.'
      : bit
        ? 'Mint $' + capital + ' of bfUSD with USDC through ' + p.name + ' on ' + chain + '. bfUSD is BitFi\'s own token, not Binance BFUSD. Gas below assumes the same ~130k gas units as a standard deposit; not measured for minting.'
        : actionFor(p, capital, chain);
    var rentNote = noAllow && gas.rent !== null && gas.rent !== undefined ? ' Plus a one-time token-account rent of ' + fmtGasUsd(rent) + '.' : '';
    var mainCostText = gas.measured
      ? '$' + capital + ' of capital and ' + gasPhrase(mainCost) + (noAllow && gas.rent !== null && gas.rent !== undefined ? ', plus a one-time token-account rent of ' + fmtGasUsd(rent) : '') + '; ' + label
      : nc !== null
        ? '$' + capital + ' of capital; ' + nc + '; no approve on XRPL'
        : '$' + capital + ' of capital; gas unmeasured on this chain';
    var list = [
      { text: bit ? 'Week 0: Open BitFi\'s own ' + program + ' page on ' + domain + ' (checked ' + checkedDay + ') and confirm the program is still listed. If the page no longer names the program, stop — do not deposit. Run this plan on one wallet only (fresh wallet, seed phrase kept offline) — never the same plan across many wallets. Connect only to view; sign nothing outside this plan\'s steps. BitFi is CeDeFi, custodied by Ceffu: counterparty risk applies. Its docs say bfBTC points ended, contradicting the bfBTC HODL section — this plan covers bfUSD only, never bfBTC.' : 'Week 0: Open ' + p.name + '\'s own ' + program + ' page on ' + domain + ' (checked ' + checkedDay + ') and confirm the program is still listed. If the page no longer names the program, stop — do not deposit. Run this plan on one wallet only (a fresh wallet, seed phrase kept offline) — never the same plan across many wallets. Connect the wallet only to view; sign nothing outside this plan\'s steps.' + (sat ? ' The program page does not say what the points convert to — not yet known.' : ''), cost: 'no fee to check', time: '10 minutes' },
      { text: 'Week 1: Approve exactly $' + capital + ' of USDC for ' + p.name + ' on ' + chain + ' — the deposit amount only, never an unlimited allowance.', cost: approveCost, time: '5 minutes' },
      { text: 'Week 1: ' + action + rentNote + ' The $' + capital + ' is a suggested starting size, not a rule: size it from your own budget and conviction — the protocol\'s TVL does not set your deposit.', cost: mainCostText, time: '15 minutes to set up' },
      { text: 'Week 1: ' + (sat ? 'Approve exactly $' + capital + ' of USDat for the sUSDat vault (the stake amount only, never unlimited), then stake it. The contracts also offer depositWithPermit, but its use in the app is unverified, so this plan budgets the approval. Gas quoted at the mint\'s unit figure; the real cost can be higher.' : bit ? 'Stake $' + capital + ' of bfUSD to Horizon or Pulsar (the First Stake quest, one time only). Providing $' + capital + ' of bfUSD as Curve liquidity is the alternative First Provide quest, not a second step. Gas quoted at the mint\'s unit figure; the real cost can be higher.' : 'Check the program\'s own rules for a second action that counts. If the rules name one, take it (same unit gas figure as the main action); if they name none, skip this step.'), cost: gas.measured ? (sat ? gasPhrase(approve) + ' to approve, ' + gasPhrase(secondCost) + ' to stake' : bit ? gasPhrase(secondCost) : 'no gas by default; ' + gasPhrase(secondCost) + ' if a second counted action is named') : (sat || bit ? 'gas unmeasured on this chain' : nc !== null ? 'no gas by default; ' + nc + ' if a second counted action is named' : 'no gas by default; gas unmeasured on this chain if a second counted action is named'), time: '10 minutes' },
      { text: 'Weeks 2–' + weeks + ': No weekly on-chain action is needed: the program names none that counts, so holding is enough. Each week open the program page, check TVL and incidents, and exit if a gate condition is met.', cost: gas.measured || nc !== null ? 'no gas by default' : 'gas unmeasured on this chain', time: '10 minutes a week' },
      { text: 'Weeks 1–' + weeks + ': Hold the position for at least ' + hold + ' days. Hypothesis: the program does not publish a snapshot schedule, so a longer hold is a guess at being counted, not a guarantee.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Week ' + weeks + ': Open ' + p.name + '\'s own ' + program + ' page on ' + domain + ' again and check the program is still live (last checked ' + checkedDay + '). If it has ended, exit at the next step instead of extending the hold.', cost: 'no fee to check', time: '10 minutes' },
      { text: 'Week ' + weeks + ': Exit gate — ' + (sat ? 'revoke both approvals on ' + chain + ': the USDC approval for ' + p.name + ' and the USDat approval for the sUSDat vault. Withdraw in two transactions: request the unstake, then claim from the withdrawal queue when ready (both at the mint\'s unit gas figure). Withdraw early, even at a loss, if a pegged asset depegs, a security incident occurs, or the points program ends or changes status.' : bit ? 'revoke the USDC approval for ' + p.name + ' on ' + chain + '. Unstake from Horizon or Pulsar, then redeem the bfUSD. Withdraw early, even at a loss, if a pegged asset depegs, a security incident occurs, or the points program ends or changes status.' : noAllow ? 'withdraw the position. Withdraw early, even at a loss, if a pegged asset depegs, the protocol reports a security incident, or the points program ends or changes status.' : 'revoke the ' + p.name + ' approval on ' + chain + ' and withdraw the position. Withdraw early, even at a loss, if a pegged asset depegs, the protocol reports a security incident, or the points program ends or changes status.'), cost: gas.measured ? (sat ? gasPhrase(approve) + ' to revoke each approval and ' + gasPhrase(deposit) + ' per withdrawal (2 approvals, 2 withdrawals)' : bit ? gasPhrase(approve) + ' to revoke the approval and ' + gasPhrase(deposit) + ' per withdrawal (1 approval, 2 withdrawals)' : noAllow ? gasPhrase(deposit) + ' to withdraw' : gasPhrase(approve) + ' to revoke the approval and ' + gasPhrase(deposit) + ' to withdraw') : nc === null ? 'gas unmeasured on this chain' : nc + ' to withdraw', time: '15 minutes' },
      { text: 'Week ' + weeks + ': ' + (bit ? 'Claim only from the link ' + p.name + ' itself publishes on its own site, and never pay anyone to claim for you. ' + p.name + '\'s docs say token airdrops will be distributed from total points, but when and how is not yet known — if no claim link is published, there is nothing to claim yet.' : 'Claim only from the link the protocol itself publishes on its own site, and never pay anyone to claim for you. If no claim link is published, there is nothing to claim yet.'), cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: totalText, cost: totalCost, time: '5 minutes' },
      { text: 'Throughout: Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ];
    if (noAllow) list.splice(1, 1); // no approve step here
    return list.map(stepText);
  }
  function verificationSteps(p, ps) {
    var checkedDay = fmtDay(ps.checked);
    var nob = p.slug === 'noble';
    var first = nob
      ? 'Week 0: Do not deposit. Noble Points (Season 2) ended in April 2026 — Dollar v2.3.0 disabled vault locking and the v11.4.0 upgrade unlocked all staked vault positions — and points.noble.xyz no longer names any points program (checked ' + checkedDay + '). The only historical points action was locking USDN in the USDN Staking Vault, forfeiting yield for points; holding USDC on Noble never earned points, and ordinary users cannot delegate on Noble\'s permissioned proof-of-authority validator set.'
      : checkedDay !== null
      ? 'Week 0: The registry last checked ' + p.name + ' on ' + checkedDay + ' and found no points program on the protocol\'s own domain, so there is no farm plan here — only checks. Start again from ' + p.name + '\'s page on DefiLlama (slug ' + p.slug + ') and follow its official-site link; an off-domain mention proves nothing.'
      : 'Week 0: No points program is on record for ' + p.name + ', so there is no farm plan here — only checks. Start from ' + p.name + '\'s page on DefiLlama (slug ' + p.slug + ') and follow its official-site link; do not deposit on the strength of a rumour.';
    return [
      { text: first, cost: 'no fee to check', time: '10 minutes' },
      { text: nob ? 'Week 0: Check Noble\'s official channels for any successor program on the new EVM L1; until one is published with rules, there is nothing to farm here. If you already hold USDC on Noble, move it off before Circle pauses the Noble USDC contract on 12 Jan 2027. Do not connect your wallet or sign anything to view a points page.' : 'Week 0: On the protocol\'s own site, look for a points or rewards page and read what it actually promises — the program\'s name, its season and which actions it counts. Do not connect your wallet or sign anything to view the points page. If there is no such page, stop here.', cost: 'no fee to check', time: '10 minutes' },
      { text: 'Week 0: Check the program\'s own page for an end date or a fixed eligibility date: a season that has ended, or eligibility that is already fixed, pays no new activity.', cost: 'no fee to check', time: '10 minutes' },
      { text: 'Week 0: What turns this into a yes: the program is listed on the protocol\'s own domain, with a named season and named actions — then a fresh registry check must confirm it before any deposit.', cost: 'no fee to check', time: '5 minutes' },
      { text: 'Week 0: What turns this into a no: no program on the official site, a program the official site says has ended, or a program only an aggregator mentions.', cost: 'no fee to check', time: '5 minutes' },
      { text: 'Throughout: Write the date and what each page said in a verification log, so the check can be repeated and the registry re-checked after 30 days.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('points')) state.points = params.get('points');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.points !== 'all') params.set('points', state.points);
    if (state.selected) params.set('p', state.selected);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function verifiedCount() {
    return DATA.rows.filter(function (r) { return r.points_status === 'verified'; }).length;
  }

  function tokenCounts() {
    var c = { live: 0, unclear: 0 };
    DATA.rows.forEach(function (r) {
      if (r.token_verification === 'verified-live') c.live++;
      else if (r.token_verification === 'unclear') c.unclear++;
    });
    return c;
  }
  function isLiveToken(r) { return r.token_verification !== 'verified-pre-token'; }
  function tokenBadge(r) {
    if (r.duplicate_of) return el('span', { class: 'status token-unclear', text: 'Duplicate of Swan DAO — same SWAN token' });
    if (r.token_verification === 'verified-live') return el('span', { class: 'status token-live', text: 'Token live: ' + (r.verified_token_symbol || '') });
    if (r.token_verification === 'unclear') return el('span', { class: 'status token-unclear', text: 'Token status unconfirmed' });
    return el('span', { class: 'status muted', text: 'No token found' });
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.points === 'verified' && r.points_status !== 'verified') return false;
      if (state.points === 'unverified' && r.points_status !== 'unknown') return false;
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
      else if (key === 'points') { av = a.points_status === 'verified' ? 1 : 0; bv = b.points_status === 'verified' ? 1 : 0; }
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
        el('span', { class: 'brand-name' }, 'Token Radar', el('small', { text: 'Ranked protocol index' }))),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    var verified = verifiedCount();
    var tc = tokenCounts();
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, DATA.watchlist_size + ' watchlist protocols, ', el('em', { text: 'ranked by model-implied value' })),
        el('p', { text: 'The board ranks ' + DATA.board_size + ' protocols by model-implied value, from the competition\'s ' + DATA.watchlist_size + '-protocol watchlist. ' + (tc.live + tc.unclear) + ' of them are stablecoin or CDP rows whose product token is live (' + tc.live + ' verified, ' + tc.unclear + ' unconfirmed), so their model values are shown as —. Implied value is the model\u2019s expected value: a token\u2019s fully-diluted value if it launches, times its token odds, from TVL, growth and maturity under a per-category power law fitted on 67 real launches. It is a model, not a promise, and it does not depend on points status. Points programs are verified for only ' + verified + ' of the ' + DATA.board_size + ' rows; the other ' + (DATA.board_size - verified) + ' carry a verification plan, not a deposit recommendation.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Rows beyond the watchlist' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function kpiStrip() {
    var tc = tokenCounts();
    var total = 0, top = null, farmN = 0;
    DATA.rows.forEach(function (r) {
      if (r.farm_verdict === 'FARM') farmN++;
      if (r.token_verification !== 'verified-pre-token') return;
      total += r.implied_value_usd || 0;
      if (r.points_status === 'verified' && (!top || r.implied_value_usd > top.implied_value_usd)) top = r;
    });
    return el('section', { class: 'kpi-strip', 'aria-label': 'Board totals' },
      el('div', { class: 'fact' }, el('span', { text: 'Candidates ranked' }), el('b', { text: String(DATA.board_size) })),
      el('div', { class: 'fact' }, el('span', { text: 'Total implied value' }), el('b', null, fmtUsd(total), el('small', { text: ' excl. ' + (tc.live + tc.unclear) + ' live-token rows' }))),
      el('div', { class: 'fact' }, el('span', { text: 'Watchlist protocols' }), el('b', { text: String(DATA.watchlist_size) })),
      el('div', { class: 'fact' }, el('span', { text: 'Verified points programs' }), el('b', { text: verifiedCount() + ' of ' + DATA.board_size })),
      el('div', { class: 'fact' }, el('span', { text: 'Top protocol' }), el('b', null, top ? top.name : 'n/a', top ? el('small', { text: ' ' + fmtUsd(top.implied_value_usd) + ' implied, verified points, no live token' }) : null)),
      el('div', { class: 'fact' }, el('span', { text: 'FARM' }), el('b', null, String(farmN), el('small', { text: ' THIN>$0 · SKIP≤$0' })))
    );
  }

  function calibrationPanel() {
    var tbody = el('tbody');
    DATA.calibration.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num' }, el('b', { text: String(c.intercept) })),
        el('td', { class: 'num', text: c.launches > 0 ? String(c.launches) : '—' }),
        el('td', { class: 'num', text: fmtMult(c.multiple) }),
        el('td', { text: c.basis })
      ));
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Where implied values come from' }),
      el('p', { text: 'Each category gets a power-law intercept, fitted on real token launches: log(FDV) = intercept + 0.418 x log(TVL). The slope is shared; only the intercept differs. On 67 usable launches the power law beats constant multiples (5-fold cross-validation median log error about 1.0 versus about 1.44), because FDV grows far slower than TVL — the implied FDV/TVL ratio falls as TVL grows. The fallback column is the constant multiple for the same category (geometric mean of winsorized FDV/TVL) — a documented fallback, not the active model.' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'calib' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', class: 'num', text: 'Intercept' }),
            el('th', { scope: 'col', class: 'num', text: 'Launches' }),
            el('th', { scope: 'col', class: 'num', text: 'Fallback multiple' }),
            el('th', { scope: 'col', text: 'Basis' })
          )),
          tbody
        )
      ),
      el('div', { class: 'note-row' }, el('p', { class: 'sub', text: 'Launches behind the table (67 app-token launches with a computable FDV/TVL; TVL from DefiLlama, FDV from first price x max supply; per-launch figures are in the entry research file). Excluded: chain tokens (valued on ecosystem potential, not TVL), launches with no TVL data, micro-TVL launches (max TVL under $5M), launches with no computable ratio. RWA uses the global intercept: two usable launches do not make a credible category estimate.' })),
      el('p', { text: 'Token odds = peers\u2019 record, not a launch forecast. Brier ' + OE.brier_cv + ' vs base ' + OE.brier_baseline + '; slope ' + OE.calibration_slope + '; AUC ' + OE.auc_oof + '. Held-out x' + OE.loo_typical_miss + '/' + OE.walkforward_typical_miss })
    );
  }

  function ledger() {
    var L = DATA.ledger;
    var p = 'Ranked:ranked;Shown:live_token_shown;Live rest:live_token_other;Excluded:excluded_category;Versioned:versioned;Wrapped:wrapped_or_staked;Exchange:exchange_name;Other:other_excluded'.split(';').map(function (t) { var a = t.split(':'); return a[0] + ' ' + L[a[1]].count + ' ' + fmtUsd(L[a[1]].tvl_usd); }).join(';');
    return el('section', { class: 'panel' },
      el('h2', { text: 'Protocol Accounting: ' + L.total + '/' + L.total }),
      el('p', { text: 'All: ' + p })
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
    var points = el('select', { id: 'points', 'aria-label': 'Filter by points status' },
      el('option', { value: 'all', text: 'All points statuses' }),
      el('option', { value: 'verified', text: 'Points verified', selected: state.points === 'verified' ? 'selected' : null }),
      el('option', { value: 'unverified', text: 'Unverified', selected: state.points === 'unverified' ? 'selected' : null })
    );
    points.addEventListener('change', function () { state.points = points.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Ranked board', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'points', text: 'Points' }), points),
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

  function boardSection(title, note, caption, list, rankLabel, rankOf) {
    var max = 1;
    list.forEach(function (r) { if (!isLiveToken(r) && r.implied_value_usd > max) max = r.implied_value_usd; });
    var tbody = el('tbody');
    list.forEach(function (r, i) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: rankOf(r, i) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, isLiveToken(r)
          ? el('div', { class: 'implied' }, el('span', { class: 'num', text: '—' }), el('span', { class: 'sub', text: r.token_verification === 'verified-live' ? 'token live' : 'status unconfirmed' }))
          : el('div', { class: 'implied' },
            el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
            el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', { class: 'num', text: isLiveToken(r) ? '—' : Math.round(r.token_odds * 100) + '%' }),
        el('td', null, vB(r)),
        el('td', null, r.points_status === 'verified' ? el('span', { class: 'status live', text: 'Points verified' }) : el('span', { class: 'status muted', text: 'Unverified' })),
        el('td', null, tokenBadge(r))
      );
      tbody.appendChild(tr);
    });
    return el('section', { class: 'panel' },
      el('h2', { text: title + ' (' + list.length + ')' }),
      el('p', { text: note }),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: caption }),
          el('thead', null, el('tr', null,
            sortHeader('implied', rankLabel),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { text: 'Odds' }),
            el('th', { text: 'Verdict' }),
            sortHeader('points', 'Points'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function boardTable() {
    var filtered = rows();
    if (filtered.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.points = 'all'; writeHash(); render(); } })
      ));
    }
    var verified = sortedRows(filtered.filter(function (r) { return r.points_status === 'verified'; }));
    verified.sort(function (a, b) { return isLiveToken(a) - isLiveToken(b); }); // pre-token first
    var unverified = sortedRows(filtered.filter(function (r) { return r.points_status !== 'verified'; }));
    var out = el('div', null);
    if (state.points !== 'unverified' && verified.length > 0) {
      out.appendChild(boardSection('Program terverifikasi',
        'These rows have a points program verified on the protocol\u2019s own domain. Select a row for its farm plan.',
        'Pre-token rows first, strongest model-implied value first within each group (within this list). Implied value is a model output from TVL, growth and maturity — it does not depend on points status.',
        verified, 'Rank', function (r, i) { return String(i + 1); }));
    }
    if (state.points !== 'verified' && unverified.length > 0) {
      out.appendChild(boardSection('Perlu verifikasi',
        'No verified points program: these rows carry a verification plan, not a deposit recommendation. Model rank is only the order of the model\u2019s implied value — not a ranking of opportunity.',
        'Strongest model-implied value first. Implied value is a model output from TVL, growth and maturity — it does not depend on points status.',
        unverified, 'Model rank', function (r) { return String(r.rank); }));
    }
    return out;
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
      el('p', { class: 'sub', text: 'One function scores every row from the snapshot figures and its category. No protocol name is special-cased; no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( exp( INTERCEPT[category] + ' + m.power_slope + ' x ln(tvl_usd) ) x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x token_odds )'
      ),
      el('ul', { class: 'method' },
        el('li', null, el('b', { text: 'INTERCEPT[category]: ' }), 'the intercept of log(FDV) on log(TVL) for the category, fitted on 67 real token launches (5-fold cross-validation median log error about 1.0, versus about 1.44 for constant multiples). The common slope ' + m.power_slope + ' means FDV grows far slower than TVL, so the implied FDV/TVL ratio falls as a protocol gets bigger — small protocols price at a high ratio, giants near or below 1x. The table above shows every intercept and its launch count.'),
        el('li', null, el('b', { text: 'Token odds: ' }), 'the fitted chance a peer has a token, from a logistic regression on all 758 snapshot protocols. Implied value is the launch value times the odds; the calibration table shows the fit.'),
        el('li', null, el('b', { text: 'Effective multiple: ' }), 'the ratio shown for a row is the power law\u2019s base divided by that protocol\u2019s TVL — the FDV/TVL the law gives at its size, not a constant. The page recomputes every row from it, so the board and detail view show the same arithmetic.'),
        el('li', null, el('b', { text: 'Growth: ' }), 'seven-day TVL change, clamped so one hot week cannot carry a row.'),
        el('li', null, el('b', { text: 'Maturity: ' }), 'age is the time since first listing; an unlisted age uses ' + m.unknown_age_days + ' days.'),
        el('li', null, el('b', { text: 'Gas costs: ' }), gasCostsDate() ? 'the farm plan\u2019s per-action figures are measured network fees as of ' + gasCostsDate() + ' (execution only \u2014 excluding L1 data fees, bridge fees and slippage; the Solana one-time token-account rent is listed separately). A chain the snapshot does not cover has no gas figure: its plan says the total cannot be calculated.' : 'the farm plan carries no measured gas figures: a chain the snapshot does not cover has none.'),
        el('li', null, el('b', { text: 'What the board ranks: ' }), 'every protocol in the snapshot whose entry records no token and that passes the board\u2019s exclusions — the ' + DATA.watchlist_size + ' watchlist protocols and the ' + DATA.early_size + ' further rows beyond the watchlist. ' + (tokenCounts().live + tokenCounts().unclear) + ' of those rows are stablecoin or CDP rows whose product token is live; the token badge on each row says so, and their model values are shown as —. Protocols that already trade are set aside in the Live token view with their market cap — a fact, not a model.'),
        el('li', null, el('b', { text: 'What is not here: ' }), 'no fees, no revenue, no social signal — the sealed snapshot carries none. The model says only what the snapshot can support.')
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
    var vp = row.value_parts;
    // 3-decimal multiple: 0.5% tolerance is the same-number check.
    var recomputed = impliedOf(row, DATA.model);
    var recomputedMatches = Math.abs(recomputed - row.implied_if_launches_usd) <= Math.max(1, row.implied_if_launches_usd * 0.005);
    var impliedNote = isLiveToken(row)
      ? 'Implied value is shown as —: ' + (row.token_verification === 'verified-live' ? 'this protocol\u2019s product token (' + (row.verified_token_symbol || 'live') + ') already trades, so a launch value does not apply.' : 'this protocol\u2019s token status is unconfirmed, so no launch value is shown.') + ' The model figure stays in board.json for audit.'
      : 'Pre-odds: ' + fmtUsd(recomputed) + (recomputedMatches ? ', = board.json. Odds ' + Math.round(row.token_odds * 100) + '% → implied value.' : ', which differs from the board: the data would be stale.') + ' Estimate, not a price.';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rank-tag', text: 'Model rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') }),
        el('div', { class: 'token-line' }, tokenBadge(row), el('span', { class: 'sub', text: row.verification_source || (row.token_verification === 'verified-pre-token' ? 'Snapshot records no token; not independently verified.' : '') }))
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Effective multiple (' + (row.category || 'Other') + ')' }), el('b', { class: 'num', text: isLiveToken(row) ? '—' : fmtMult(row.multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age since listing' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'If launch' }), el('b', { class: 'num', text: isLiveToken(row) ? '—' : fmtUsd(row.implied_if_launches_usd) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num hl', text: isLiveToken(row) ? '—' : fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Multiple basis: ' + basis.basis + (basis.launches > 0 ? ' (' + basis.launches + ' launch' + (basis.launches === 1 ? '' : 'es') + ').' : '.') + ' Implied value is a model output from TVL, growth and maturity; it does not depend on points status. Model ' + DATA.model_version + ': the same function scores every protocol. ' + impliedNote }),
      isLiveToken(row) ? null : el('p', { class: 'sub', text: 'Parts: ' + fmtUsd(vp.base_usd) + 'x' + vp.growth + 'x' + vp.maturity + 'x' + vp.odds + '=' + fmtUsd(row.implied_value_usd) + '. Peers MCAP/TVL:' + row.nearest_peers.map(function (p) { return p.name + ' ' + p.mcap_multiple + 'x'; }).join(',') })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm verdict' }),
      vB(row),
      el('p', { class: 'sub', text: 'Slice $' + row.verdict_slice_usd.toFixed(2) + ' fees ' + (row.verdict_fees_measured ? fmtGasUsd(row.verdict_fees_usd) : 'unmeasured') + ' T-bill $' + row.verdict_tbill_usd.toFixed(2) + ' net $' + row.verdict_net_usd.toFixed(2) + ' ($' + row.verdict_net_per_hour_usd.toFixed(2) + '/hr). ' + (VP.drop_share * 100) + '% share, ' + (VP.tbill_annual_rate * 100) + '% TB; FARM>$' + VP.farm_net_usd + ',>$' + VP.farm_net_per_hour_usd + '/hr.' + (row.verdict_basis === 'verified' ? '' : ' Conditional: if verified+launches.') })
    ));
    var isVerified = row.points_status === 'verified';
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: isVerified ? 'Farm plan' : 'Verification plan' }),
      el('p', { class: 'sub', text: isVerified
        ? 'Program ' + (row.points_program || 'points program') + ', checked ' + (fmtDay(row.points_checked) || 'recently') + ' on the protocol\u2019s own domain. The plan below only makes sense while that program stays live.'
        : 'No points program is verified for this protocol. The plan below checks whether one exists — it recommends no deposit.' }),
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
    shell.appendChild(kpiStrip());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') {
      shell.appendChild(calibrationPanel());
      shell.appendChild(ledger());
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
