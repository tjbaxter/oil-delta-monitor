from __future__ import annotations

from datetime import date, datetime, time, timezone
from math import exp, log, sqrt
from typing import Any

from scipy.stats import norm


EPSILON_T = 1e-6
EPSILON_S = 1e-6


def norm_cdf(x: float) -> float:
    return float(norm.cdf(x))


def bs_call_price(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if S <= 0 or K <= 0:
        raise ValueError("S and K must be positive for Black-Scholes.")

    if T <= EPSILON_T or sigma <= 0:
        return max(S - K, 0.0)

    sqrt_t = sqrt(T)
    d1 = (log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    return S * norm_cdf(d1) - K * exp(-r * T) * norm_cdf(d2)


def tight_call_spread_fair_probability(
    S: float,
    strike: float,
    width: float,
    T: float,
    r: float,
    sigma: float,
) -> float:
    if width <= 0:
        raise ValueError("Spread width must be positive.")

    k1 = strike - width / 2.0
    k2 = strike + width / 2.0
    c1 = bs_call_price(S=S, K=k1, T=max(T, EPSILON_T), r=r, sigma=sigma)
    c2 = bs_call_price(S=S, K=k2, T=max(T, EPSILON_T), r=r, sigma=sigma)

    fair_prob = (c1 - c2) / width
    return max(0.0, min(1.0, fair_prob))


def call_spread_delta(
    S: float,
    strike: float,
    width: float,
    T: float,
    r: float,
    sigma: float,
    h: float = 0.01,
) -> float:
    if h <= 0:
        raise ValueError("h must be positive.")

    s_up = max(S + h, EPSILON_S)
    s_dn = max(S - h, EPSILON_S)

    p_up = tight_call_spread_fair_probability(s_up, strike, width, T, r, sigma)
    p_dn = tight_call_spread_fair_probability(s_dn, strike, width, T, r, sigma)
    return (p_up - p_dn) / (s_up - s_dn)


def year_fraction_to_expiry(expiry_datetime_or_date: Any, now_utc: datetime) -> float:
    if isinstance(expiry_datetime_or_date, datetime):
        expiry_dt = expiry_datetime_or_date
    elif isinstance(expiry_datetime_or_date, date):
        expiry_dt = datetime.combine(expiry_datetime_or_date, time(23, 59, tzinfo=timezone.utc))
    else:
        raise ValueError("Expiry must be a datetime or date.")

    if expiry_dt.tzinfo is None:
        expiry_dt = expiry_dt.replace(tzinfo=timezone.utc)
    else:
        expiry_dt = expiry_dt.astimezone(timezone.utc)

    now = now_utc.astimezone(timezone.utc)
    dt_seconds = (expiry_dt - now).total_seconds()
    year_fraction = dt_seconds / (365.0 * 24.0 * 3600.0)
    return max(year_fraction, EPSILON_T)
