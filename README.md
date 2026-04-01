# CL Delta Scope

Real-time dislocation monitor: Kalshi WTI daily binaries vs Black-Scholes call spread fair value.

**Live:** [cldelta.com](https://cldelta.com)

![Dashboard screenshot](docs/dashboard.png)

---

## What this does

Kalshi lists daily binary contracts on WTI crude oil — "Will CL settle above $X today?" These contracts trade at a market-determined price that implies a probability. The same probability can be derived analytically by pricing a tight call spread in Black-Scholes using the live CME futures price.

Both are answering the same question. They should agree. When they don't, one of them is wrong, and that's a trading signal.

This dashboard streams both in real time, plots them against each other, and measures the gap.

## The idea

From [Kris Abdelmessih's Moontower piece](https://moontower.substack.com/p/a-market-making-project-you-can-do) on market-making around a fair value:

A $1-wide call spread (e.g. 99.5/100.5) priced at 90 IV approximates the probability that CL settles above the midpoint ($100). Three of the four BSM inputs are either fixed or near-static — only the futures price S moves in real time. So with one live data feed and one formula, you get a smooth theoretical fair value for the binary question.

The Kalshi contract prices the same question, but through order flow, sentiment, and market microstructure. It's noisier. The slope of Kalshi probability vs CL price (the implied delta) can diverge from the call spread's theoretical delta. When Kalshi's implied delta is steeper than the model, the market is overreacting to price moves — you'd sell Kalshi and hedge with futures. When it's flatter, you'd buy.

The ratio of slopes is the edge signal.

## What you're looking at

**Left chart — Heartbeat.** Teal line is Kalshi's market mid. Orange line is the BSM call spread fair value. Both are plotting probability (%) against time. The orange line moves smoothly because it's pure math; the teal line bounces because it's a traded market.

**Right chart — Delta scatter.** Each dot is a snapshot: x = CL price, y = probability. The slope of each regression line is the delta — how many probability points move per $1 in CL. Comparing the two slopes tells you whether the market is over- or under-reacting relative to the model.

**KPI cards.** CL price (Databento MBP-1), Kalshi mid, call spread fair value, and the gap in cents. The gap card turns red (sell signal — market rich) or green (buy signal — market cheap).

![Scatter detail](docs/scatter.png)

## Architecture

```
CME CL.c.0 (Databento MBP-1)  ──→  Python ingestor  ──→  live_snapshot.json
                                         │
Kalshi REST API (public)       ──→       │
                                         ↓
                                    Next.js SSR  ──→  cldelta.com
                                         │
                                    Black-Scholes
                                    call spread
                                    pricing (server)
```

The Python ingestor runs continuously, streaming CL front-month quotes via Databento's live API and polling Kalshi's public orderbook. On every tick it recomputes the BSM call spread value and writes a snapshot to disk. The Next.js frontend reads this snapshot server-side on each request (no loading spinner — the page arrives fully populated) and polls for updates after hydration.

**Strike selection** is automatic. On startup and throughout the day, the system picks the Kalshi contract closest to 50¢ (the ATM strike). If the current contract drifts past 75¢ or below 25¢ and a better strike exists, it re-centres with hysteresis to prevent thrashing.

**Feed recovery** handles the daily CME maintenance break (21:00–22:00 UTC) automatically: the ingestor detects graceful disconnects, reconnects after a delay, and replays missed data using Databento's intraday replay with `subscribe(start=...)`.

## Key design choices

**Why Kalshi over Polymarket.** Kalshi settles daily — fresh contract every trading day, liquid during US hours, regulated exchange. Polymarket's crude contracts are monthly with thin books.

**Why not stream options data.** You don't need a live options feed. BSM with constant vol on a $1-wide spread is vega-neutral — the long and short legs cancel. IV barely matters. You just track S and recompute. One futures feed, one formula.

**Why forward-fill CL for fair value.** CL doesn't tick every second during quiet periods, but the BSM fair value is identical when S hasn't moved. The ingestor forward-fills the last CL price (if < 60s old) on every Kalshi tick so the orange line spans the full chart width.

**Why server-side render.** The snapshot is read from disk on each request and embedded in the initial HTML. The page arrives pre-populated — no client-side fetch waterfall before the chart appears.

## Running locally

```bash
# Clone
git clone https://github.com/tjbaxter/oil-delta-monitor.git
cd oil-delta-monitor

# Environment
cp .env.example .env.local
# Add your DATABENTO_API_KEY to .env.local

# Install
npm install
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Run
npm run dev          # Next.js on localhost:3000
npm run dev:live     # Python ingestor (separate terminal)
```

Requires a [Databento](https://databento.com) account with CME Globex live data access. Kalshi uses the public API — no account needed.

## Stack

Python 3.12, Next.js 15, TypeScript, Databento (CME CL.c.0 MBP-1), Kalshi REST API, Black-Scholes, Caddy, GCE (europe-west2).

## Reading the delta ratio

The scatter panel shows:

- **Δ kalshi** — regression slope of Kalshi probability vs CL price. This is the market's implied delta.
- **Δ theo** — regression slope of BSM fair value vs CL price. This is the model delta.
- **ratio** — kalshi delta / theo delta.

A ratio above 1.0 means Kalshi overreacts to CL moves relative to the model. Below 1.0, it underreacts. Persistent ratios far from 1.0 are the market-making opportunity Kris describes.

In practice, the ratio fluctuates. The interesting moments are when it spikes — that's when order flow has temporarily pushed the prediction market away from its theoretical anchor, and a convergence trade becomes attractive.

## Acknowledgements

Concept from Kris Abdelmessih's [Moontower newsletter](https://moontower.substack.com/p/a-market-making-project-you-can-do). Adapted from Polymarket to Kalshi daily contracts for better liquidity and daily settlement.
