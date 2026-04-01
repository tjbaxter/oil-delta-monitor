# oil-delta-monitor

Compact Streamlit monitor for a Polymarket crude-oil binary (for example, "Will crude oil settle above $90?"). It compares live Polymarket implied probability against a Black-Scholes tight call-spread fair value and tracks empirical vs theoretical delta behavior over time.

## What It Tracks

- Live Polymarket YES probability for a selected market slug
- Crude proxy price from `CL=F` (yfinance)
- Tight call-spread fair probability around a strike
- Fair-value gap (`poly - fair`)
- Empirical rolling Polymarket delta vs theoretical spread delta

## How It Works

1. Pull market data from Polymarket public endpoints (slug first, search fallback).
2. Pull crude proxy price from yfinance.
3. Price a narrow call spread around the strike and normalize to a probability proxy.
4. Compute theoretical spread delta and empirical rolling delta from observed history.
5. Display KPI cards, heartbeat chart, scatter/slope panel, and a recent observation table.

v1 uses a public crude proxy feed and has no execution layer.

## Local Run

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
streamlit run app.py
```

## Repo Structure

- `app.py` - Streamlit dashboard
- `src/config.py` - defaults and colors
- `src/data_sources.py` - Polymarket/yfinance access + parsing
- `src/pricing.py` - Black-Scholes and call-spread fair value/delta
- `src/analytics.py` - empirical delta, regression slope, signal labeling

## Next Steps

- Add a more direct futures/options data source in place of `CL=F`
- Improve market/expiry mapping for active Polymarket oil contracts
- Add optional persistence beyond Streamlit session state
