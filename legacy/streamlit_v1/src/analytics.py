from __future__ import annotations

import numpy as np
import pandas as pd


def instantaneous_delta(
    prev_prob: float,
    prev_price: float,
    curr_prob: float,
    curr_price: float,
) -> float | None:
    d_price = curr_price - prev_price
    if abs(d_price) < 1e-12:
        return None
    return (curr_prob - prev_prob) / d_price


def rolling_regression_slope(x: pd.Series, y: pd.Series) -> float | None:
    mask = x.notna() & y.notna() & np.isfinite(x) & np.isfinite(y)
    x_values = x[mask].to_numpy(dtype=float)
    y_values = y[mask].to_numpy(dtype=float)

    if len(x_values) < 2:
        return None
    if np.isclose(np.std(x_values), 0.0):
        return None

    try:
        slope = np.polyfit(x_values, y_values, deg=1)[0]
    except np.linalg.LinAlgError:
        return None
    return float(slope)


def classify_signal(
    fair_value_gap: float,
    delta_gap: float,
    fair_gap_threshold: float,
    delta_gap_threshold: float,
) -> str:
    if fair_value_gap > fair_gap_threshold and delta_gap > delta_gap_threshold:
        return "Poly rich"
    if fair_value_gap < -fair_gap_threshold and delta_gap < -delta_gap_threshold:
        return "Poly cheap"
    return "Neutral"


def add_analytics_columns(
    df: pd.DataFrame,
    rolling_window: int,
    fair_gap_threshold: float,
    delta_gap_threshold: float,
) -> pd.DataFrame:
    work = df.copy()
    if work.empty:
        for column in (
            "fair_value_gap",
            "empirical_delta_inst",
            "empirical_delta_roll",
            "delta_gap",
            "signal",
        ):
            work[column] = pd.Series(dtype=float if column != "signal" else str)
        return work

    work = work.sort_values("timestamp").reset_index(drop=True)
    work["fair_value_gap"] = work["poly_prob"] - work["fair_prob"]

    d_prob = work["poly_prob"].diff()
    d_price = work["crude_price"].diff()
    work["empirical_delta_inst"] = np.where(d_price.abs() > 1e-12, d_prob / d_price, np.nan)

    safe_window = max(2, int(rolling_window))
    roll_values: list[float] = []
    for idx in range(len(work)):
        start_idx = max(0, idx - safe_window + 1)
        x_slice = work.loc[start_idx:idx, "crude_price"]
        y_slice = work.loc[start_idx:idx, "poly_prob"]
        slope = rolling_regression_slope(x_slice, y_slice)
        roll_values.append(np.nan if slope is None else slope)

    work["empirical_delta_roll"] = roll_values
    work["delta_gap"] = work["empirical_delta_roll"] - work["theoretical_delta"]
    work["signal"] = [
        classify_signal(
            fair_value_gap=float(fair_gap) if pd.notna(fair_gap) else 0.0,
            delta_gap=float(delta_gap) if pd.notna(delta_gap) else 0.0,
            fair_gap_threshold=fair_gap_threshold,
            delta_gap_threshold=delta_gap_threshold,
        )
        for fair_gap, delta_gap in zip(work["fair_value_gap"], work["delta_gap"])
    ]
    return work
