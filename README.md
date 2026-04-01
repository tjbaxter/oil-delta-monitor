# Crude Probability Dislocation Monitor

Real-time monitor for a Polymarket crude-oil binary versus a Black-Scholes tight call-spread fair value. The UI is a Next.js dashboard, but live market collection happens in a small Python sidecar so the page can load from a fast local snapshot instead of waiting on external feeds.

## What It Tracks

- Polymarket `cl-above-90-jun-2026`
- live Polymarket best bid, best ask, spread, midpoint, last trade, and display mark
- live CME crude via Databento `GLBX.MDP3` / `CL.c.0`
- fair probability from an `89.5 / 90.5` call spread around strike `90`
- empirical Poly delta versus theoretical spread delta

## Architecture

- `services/live_ingestor/` is the live source of truth
- the ingestor seeds recent history, subscribes to Databento live server-side, subscribes to the Polymarket market websocket, and writes:
  - `data/live_snapshot.json`
  - `data/live_observations.jsonl`
  - `data/sessions/<session>/...`
- `app/api/live-snapshot/route.ts` only reads the local snapshot file
- `components/dashboard/DashboardClient.tsx` polls the local snapshot and recomputes analytics locally when model inputs change

The browser never talks to Databento directly.

## Polymarket Display Rule

The monitor uses the same display rule as Polymarket:

- midpoint when spread `<= $0.10`
- otherwise last traded price

Historical `prices-history` is still trade-price history only. From the moment the recorder is running, the app starts building its own prospective midpoint/spread history locally.

## Local Setup

Create `.env.local`:

```bash
DATABENTO_API_KEY=your_key_here
NEXT_PUBLIC_MONITOR_MODE=live
```

Install dependencies:

```bash
npm install
python3 -m pip install -r services/live_ingestor/requirements.txt
```

Run in two terminals:

```bash
npm run dev:live
```

```bash
npm run dev:web
```

Or start both with:

```bash
npm run dev:all
```

Open the local Next.js URL printed by `npm run dev:web`.

## Repo Map

- `app/`: App Router page, loading shell, and snapshot routes
- `components/dashboard/`: presentation-first monitor UI
- `lib/analytics.ts`, `lib/pricing.ts`: fair value, deltas, gaps, slope ratio
- `lib/polymarket.ts`, `lib/crude.ts`: delayed/archive backfill helpers
- `services/live_ingestor/`: Python recorder, feeds, state, and snapshot writer

## Notes

- The app is a monitor, not an execution system.
- Databento credentials stay server-side.
- Delayed/archive mode still exists for the old bootstrap path by setting `NEXT_PUBLIC_MONITOR_MODE=delayed`.
- Historical Polymarket midpoint data before the recorder starts is not invented.
