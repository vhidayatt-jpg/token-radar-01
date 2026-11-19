# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/vhidayatt-jpg/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/vhidayatt-jpg/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks pre-token DeFi protocols by implied launch value, from a sealed DefiLlama snapshot (14 Nov 2026). It covers all 40 watchlist protocols (TVL ≥ $50M, no token) plus every other rankable pre-token protocol in the snapshot, 197 rows in total — wrapped/staked/bridged products, exchanges and versioned pools are excluded, as the competition defines a launch. Each protocol's implied value comes from a per-category power law fitted on 67 real app-token launches — log(FDV) = intercept[category] + 0.418 x log(TVL) — times growth and maturity multipliers from the snapshot's own figures, validated out-of-sample against constant multiples. Every row carries an 8-step farm plan with execution costs measured live on 20 Nov 2026. The dashboard is a static, no-network page: a sortable and filterable board, a detail view per protocol, and a dossier for the judge.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=s8fb6vz8&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
