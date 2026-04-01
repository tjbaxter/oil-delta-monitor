from __future__ import annotations

from datetime import date, datetime, time as dt_time, timedelta, timezone
import time
from typing import Any

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st

from src.analytics import add_analytics_columns
from src.config import (
    COLOR_BG,
    COLOR_BORDER,
    COLOR_CARD_BG,
    COLOR_CRUDE,
    COLOR_NEGATIVE,
    COLOR_NEUTRAL,
    COLOR_POLY,
    COLOR_POSITIVE,
    COLOR_THEO,
    DEFAULT_APP_TITLE,
    DEFAULT_DELTA_GAP_THRESHOLD,
    DEFAULT_FAIR_GAP_THRESHOLD,
    DEFAULT_IV,
    DEFAULT_MARKET_SLUG,
    DEFAULT_POLLING_INTERVAL_SECONDS,
    DEFAULT_RISK_FREE_RATE,
    DEFAULT_ROLLING_WINDOW,
    DEFAULT_SPREAD_WIDTH,
    DEFAULT_STRIKE,
    streamlit_page_config,
)
from src.data_sources import (
    extract_expiry_from_market,
    fetch_polymarket_market_by_slug,
    fetch_polymarket_markets_search,
    get_crude_price,
    parse_market_status,
    parse_market_title,
    parse_yes_probability,
    utc_now,
)
from src.pricing import call_spread_delta, tight_call_spread_fair_probability, year_fraction_to_expiry


BASE_HISTORY_COLUMNS = [
    "timestamp",
    "market_slug",
    "market_title",
    "market_status",
    "crude_price",
    "poly_prob",
    "fair_prob",
    "theoretical_delta",
]


def empty_history_df() -> pd.DataFrame:
    return pd.DataFrame(columns=BASE_HISTORY_COLUMNS)


def inject_css() -> None:
    st.markdown(
        f"""
        <style>
        #MainMenu {{visibility: hidden;}}
        footer {{visibility: hidden;}}
        header {{visibility: hidden;}}
        section[data-testid="stSidebar"] {{display: none;}}
        .stApp {{
            background: {COLOR_BG};
            color: #D1DAE8;
        }}
        .block-container {{
            padding-top: 0.65rem;
            padding-bottom: 0.75rem;
            padding-left: 1.0rem;
            padding-right: 1.0rem;
            max-width: 100%;
        }}
        div[data-testid="stHorizontalBlock"] {{
            gap: 0.50rem;
        }}
        .title-row {{
            padding: 0.30rem 0.55rem 0.38rem 0.55rem;
            border: 1px solid {COLOR_BORDER};
            background: {COLOR_CARD_BG};
            border-radius: 10px;
            margin-bottom: 0.55rem;
        }}
        .title-main {{
            font-size: 1.10rem;
            font-weight: 650;
            line-height: 1.2;
            color: #F1F6FE;
        }}
        .title-sub {{
            margin-top: 0.14rem;
            color: #9DAAC0;
            font-size: 0.74rem;
        }}
        .title-time {{
            color: #8A97A8;
            font-size: 0.70rem;
            text-align: right;
            margin-top: 0.30rem;
            font-family: "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace;
        }}
        .controls-caption {{
            color: #8C9AAE;
            font-size: 0.68rem;
            margin-top: 0.15rem;
        }}
        .kpi-card {{
            background: {COLOR_CARD_BG};
            border: 1px solid {COLOR_BORDER};
            border-radius: 10px;
            padding: 0.52rem 0.66rem 0.56rem 0.66rem;
            min-height: 104px;
            box-shadow: 0 0 0.38rem rgba(20, 35, 60, 0.30);
        }}
        .kpi-label {{
            color: #8D9AAC;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-size: 0.62rem;
            font-family: "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace;
        }}
        .kpi-value {{
            color: #E9F0FA;
            font-size: 1.42rem;
            font-weight: 620;
            margin-top: 0.18rem;
            line-height: 1.18;
        }}
        .kpi-sub {{
            color: #96A4B6;
            font-size: 0.70rem;
            margin-top: 0.22rem;
            line-height: 1.2;
        }}
        .status-panel {{
            border: 1px solid {COLOR_BORDER};
            background: #0A1523;
            border-radius: 8px;
            padding: 0.45rem 0.6rem;
            color: #AFC0D8;
            font-size: 0.74rem;
            margin: 0.35rem 0 0.48rem 0;
        }}
        .empty-panel {{
            border: 1px solid {COLOR_BORDER};
            background: {COLOR_CARD_BG};
            border-radius: 10px;
            padding: 0.9rem 1rem;
            margin-top: 0.45rem;
        }}
        .empty-title {{
            color: #E6EEF9;
            font-size: 0.95rem;
            margin-bottom: 0.34rem;
            font-weight: 560;
        }}
        .empty-body {{
            color: #9FAFC3;
            font-size: 0.75rem;
            line-height: 1.35;
        }}
        div[data-testid="stMetric"] {{
            border: 1px solid {COLOR_BORDER};
            border-radius: 9px;
            background: {COLOR_CARD_BG};
            padding: 0.35rem 0.52rem 0.3rem 0.52rem;
        }}
        .stDataFrame {{
            border: 1px solid {COLOR_BORDER};
            border-radius: 8px;
        }}
        </style>
        """,
        unsafe_allow_html=True,
    )


def format_prob(value: Any) -> str:
    if value is None or pd.isna(value):
        return "—"
    return f"{100.0 * float(value):.2f}%"


def format_cents(value: Any) -> str:
    if value is None or pd.isna(value):
        return "—"
    return f"{100.0 * float(value):.1f}c"


def format_price(value: Any) -> str:
    if value is None or pd.isna(value):
        return "—"
    return f"${float(value):.2f}"


def format_num(value: Any, digits: int = 4) -> str:
    if value is None or pd.isna(value):
        return "—"
    return f"{float(value):.{digits}f}"


def signal_color(signal: str) -> str:
    if signal == "Poly rich":
        return COLOR_NEGATIVE
    if signal == "Poly cheap":
        return COLOR_POSITIVE
    return COLOR_NEUTRAL


def signal_subtext(signal: str) -> str:
    if signal == "Poly rich":
        return "Poly rich - sell signal"
    if signal == "Poly cheap":
        return "Poly cheap - buy signal"
    return "Neutral"


def render_kpi_card(label: str, value: str, subtitle: str, value_color: str = "#E9F0FA") -> None:
    st.markdown(
        f"""
        <div class="kpi-card">
          <div class="kpi-label">{label}</div>
          <div class="kpi-value" style="color:{value_color};">{value}</div>
          <div class="kpi-sub">{subtitle}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_status_line(messages: list[str]) -> None:
    if not messages:
        return
    text = " | ".join(messages)
    st.markdown(f'<div class="status-panel">{text}</div>', unsafe_allow_html=True)


def render_no_data_panel() -> None:
    st.markdown(
        """
        <div class="empty-panel">
          <div class="empty-title">No live observation yet</div>
          <div class="empty-body">
            1) Paste a live market slug or run manual search.<br>
            2) Select a relevant oil market candidate.<br>
            3) Click refresh and wait for one successful data pull.
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def make_empty_panel_chart(title: str, body: str, height: int = 410) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(
        text=body,
        x=0.5,
        y=0.5,
        xref="paper",
        yref="paper",
        showarrow=False,
        font=dict(size=12, color="#9FAFC3"),
    )
    fig.update_layout(
        title=title,
        margin=dict(l=14, r=14, t=30, b=14),
        height=height,
        paper_bgcolor=COLOR_BG,
        plot_bgcolor=COLOR_BG,
        font=dict(color="#D1DAE8"),
        xaxis=dict(visible=False),
        yaxis=dict(visible=False),
    )
    return fig


def should_append_observation(history_df: pd.DataFrame, row: dict[str, Any], now_utc: datetime) -> bool:
    if history_df.empty:
        return True

    last_row = history_df.iloc[-1]
    numeric_cols = ("crude_price", "poly_prob", "fair_prob", "theoretical_delta")
    same_values = all(
        pd.notna(last_row[col]) and row.get(col) is not None and np.isclose(float(last_row[col]), float(row[col]), atol=1e-8)
        for col in numeric_cols
    )

    last_ts = pd.to_datetime(last_row["timestamp"], utc=True, errors="coerce")
    if pd.isna(last_ts):
        return True

    seconds_since_last = (now_utc - last_ts.to_pydatetime()).total_seconds()
    return not (same_values and seconds_since_last < 5.0)


def _fit_line(x: pd.Series, y: pd.Series) -> tuple[float | None, float | None]:
    mask = x.notna() & y.notna() & np.isfinite(x) & np.isfinite(y)
    x_values = x[mask].to_numpy(dtype=float)
    y_values = y[mask].to_numpy(dtype=float)
    if len(x_values) < 2:
        return None, None
    if np.isclose(np.std(x_values), 0.0):
        return None, None
    slope, intercept = np.polyfit(x_values, y_values, 1)
    return float(slope), float(intercept)


def make_heartbeat_chart(df: pd.DataFrame) -> go.Figure:
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(
        go.Scatter(
            x=df["timestamp"],
            y=df["poly_prob"],
            mode="lines+markers",
            name="Poly",
            line=dict(color=COLOR_POLY, width=2.3),
            marker=dict(size=4),
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Scatter(
            x=df["timestamp"],
            y=df["fair_prob"],
            mode="lines",
            name="Fair",
            line=dict(color=COLOR_THEO, width=2.1),
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Scatter(
            x=df["timestamp"],
            y=df["crude_price"],
            mode="lines",
            name="CL (right)",
            line=dict(color=COLOR_CRUDE, width=1.7),
            opacity=0.9,
        ),
        secondary_y=True,
    )
    fig.update_layout(
        title="Heartbeat",
        margin=dict(l=14, r=14, t=30, b=14),
        height=400,
        paper_bgcolor=COLOR_BG,
        plot_bgcolor=COLOR_BG,
        font=dict(color="#D1DAE8"),
        legend=dict(orientation="h", yanchor="bottom", y=1.01, x=0.0),
    )
    fig.update_yaxes(title_text="Probability", secondary_y=False, tickformat=".0%")
    fig.update_yaxes(title_text="CL", secondary_y=True)
    fig.update_xaxes(showgrid=False)
    return fig


def make_scatter_chart(df: pd.DataFrame) -> tuple[go.Figure, float | None, float | None]:
    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=df["crude_price"],
            y=df["poly_prob"],
            mode="markers",
            name="Poly",
            marker=dict(color=COLOR_POLY, size=8, opacity=0.74),
        )
    )
    fig.add_trace(
        go.Scatter(
            x=df["crude_price"],
            y=df["fair_prob"],
            mode="markers",
            name="Fair",
            marker=dict(color=COLOR_THEO, size=7, opacity=0.72),
        )
    )

    poly_slope, poly_intercept = _fit_line(df["crude_price"], df["poly_prob"])
    theo_slope, theo_intercept = _fit_line(df["crude_price"], df["fair_prob"])

    x_min = float(df["crude_price"].min())
    x_max = float(df["crude_price"].max())
    x_line = np.array([x_min, x_max], dtype=float)

    if poly_slope is not None and poly_intercept is not None:
        fig.add_trace(
            go.Scatter(
                x=x_line,
                y=poly_intercept + poly_slope * x_line,
                mode="lines",
                name="Poly fit",
                line=dict(color=COLOR_POLY, width=2.2, dash="dot"),
            )
        )
    if theo_slope is not None and theo_intercept is not None:
        fig.add_trace(
            go.Scatter(
                x=x_line,
                y=theo_intercept + theo_slope * x_line,
                mode="lines",
                name="Fair fit",
                line=dict(color=COLOR_THEO, width=2.2, dash="dot"),
            )
        )

    slope_ratio: float | None = None
    if poly_slope is not None and theo_slope is not None and not np.isclose(theo_slope, 0.0):
        slope_ratio = poly_slope / theo_slope

    if slope_ratio is not None and poly_slope is not None and theo_slope is not None:
        slope_text = (
            f"poly = {poly_slope:.4f} / $<br>"
            f"theo = {theo_slope:.4f} / $<br>"
            f"ratio = {slope_ratio:.2f}x"
        )
    else:
        slope_text = "poly/theo slope: insufficient data"

    fig.add_annotation(
        x=0.02,
        y=0.98,
        xref="paper",
        yref="paper",
        showarrow=False,
        align="left",
        text=slope_text,
        bordercolor=COLOR_BORDER,
        borderwidth=1,
        bgcolor="#091525",
        font=dict(size=11, color="#D1DAE8"),
    )
    fig.update_layout(
        title="Scatter / Slope / Delta",
        margin=dict(l=14, r=14, t=30, b=14),
        height=430,
        paper_bgcolor=COLOR_BG,
        plot_bgcolor=COLOR_BG,
        font=dict(color="#D1DAE8"),
        legend=dict(orientation="h", yanchor="bottom", y=1.01, x=0.0),
    )
    fig.update_xaxes(title_text="CL")
    fig.update_yaxes(title_text="Probability", tickformat=".0%")
    return fig, poly_slope, theo_slope


def build_search_table(search_results: list[dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for item in search_results:
        rows.append(
            {
                "title": parse_market_title(item),
                "slug": str(item.get("slug", "")),
                "status": parse_market_status(item),
                "end_date": str(item.get("endDate", "")),
            }
        )
    table = pd.DataFrame(rows)
    if table.empty:
        return table
    return table.sort_values(["status", "end_date"], ascending=[True, True])


st.set_page_config(**streamlit_page_config())
inject_css()

if "history" not in st.session_state:
    st.session_state["history"] = empty_history_df()
if "market_slug" not in st.session_state:
    st.session_state["market_slug"] = DEFAULT_MARKET_SLUG
if "search_query" not in st.session_state:
    st.session_state["search_query"] = "crude oil"
if "search_results" not in st.session_state:
    st.session_state["search_results"] = []
if "auto_refresh" not in st.session_state:
    st.session_state["auto_refresh"] = False
if "polling_interval_seconds" not in st.session_state:
    st.session_state["polling_interval_seconds"] = DEFAULT_POLLING_INTERVAL_SECONDS
if "use_market_expiry" not in st.session_state:
    st.session_state["use_market_expiry"] = True
if "manual_expiry_date" not in st.session_state:
    st.session_state["manual_expiry_date"] = (datetime.now(timezone.utc) + timedelta(days=30)).date()

now_utc = utc_now()
history = st.session_state["history"]
last_update_text = "--"
if not history.empty:
    last_ts = pd.to_datetime(history.iloc[-1]["timestamp"], utc=True, errors="coerce")
    if pd.notna(last_ts):
        last_update_text = last_ts.strftime("%H:%M:%S")

title_cols = st.columns([1.8, 1.0])
with title_cols[0]:
    st.markdown(
        f"""
        <div class="title-row">
          <div class="title-main">{DEFAULT_APP_TITLE}</div>
          <div class="title-sub">Poly $90+ vs call spread fair value</div>
        </div>
        """,
        unsafe_allow_html=True,
    )
with title_cols[1]:
    st.markdown(
        f"""
        <div class="title-row">
          <div class="title-time">UTC {now_utc.strftime("%Y-%m-%d %H:%M:%S")} | last {last_update_text}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )

with st.expander("Controls", expanded=False):
    top_controls = st.columns([2.5, 1.8, 0.9, 0.9])
    with top_controls[0]:
        st.text_input("Market slug", key="market_slug", placeholder="paste live polymarket slug")
    with top_controls[1]:
        st.text_input("Search text", key="search_query", placeholder="crude oil")
    with top_controls[2]:
        st.checkbox("Auto refresh", key="auto_refresh")
    with top_controls[3]:
        st.number_input("Poll sec", min_value=5, max_value=300, step=5, key="polling_interval_seconds")

    pricing_controls = st.columns(4)
    with pricing_controls[0]:
        strike = float(st.number_input("Strike", min_value=0.01, value=DEFAULT_STRIKE, step=0.5, format="%.2f"))
        spread_width = float(
            st.number_input("Spread width", min_value=0.05, value=DEFAULT_SPREAD_WIDTH, step=0.05, format="%.2f")
        )
    with pricing_controls[1]:
        implied_vol = float(st.number_input("Implied vol", min_value=0.01, value=DEFAULT_IV, step=0.01, format="%.2f"))
        risk_free_rate = float(
            st.number_input("Risk-free rate", min_value=-0.10, max_value=0.20, value=DEFAULT_RISK_FREE_RATE, step=0.005)
        )
    with pricing_controls[2]:
        rolling_window = int(st.number_input("Rolling window", min_value=5, max_value=500, value=DEFAULT_ROLLING_WINDOW))
        fair_gap_threshold = float(
            st.number_input("Fair gap threshold", min_value=0.0, value=DEFAULT_FAIR_GAP_THRESHOLD, step=0.005)
        )
    with pricing_controls[3]:
        delta_gap_threshold = float(
            st.number_input("Delta gap threshold", min_value=0.0, value=DEFAULT_DELTA_GAP_THRESHOLD, step=0.005)
        )
        st.checkbox("Use market expiry", key="use_market_expiry")
        st.date_input("Manual expiry", key="manual_expiry_date")

    action_controls = st.columns([1, 1, 1, 4])
    with action_controls[0]:
        search_clicked = st.button("Search markets")
    with action_controls[1]:
        st.button("Refresh now", type="primary")
    with action_controls[2]:
        reset_history = st.button("Reset history")
    with action_controls[3]:
        st.markdown('<div class="controls-caption">Manual slug is primary; search is filtered to oil keywords only.</div>', unsafe_allow_html=True)

if reset_history:
    st.session_state["history"] = empty_history_df()
    st.rerun()

if search_clicked:
    search_query = st.session_state["search_query"].strip()
    if not search_query:
        st.session_state["search_results"] = []
        st.session_state["search_message"] = "Enter search text first."
    else:
        try:
            results = fetch_polymarket_markets_search(search_query, limit=30)
            st.session_state["search_results"] = results
            if results:
                st.session_state["search_message"] = f"Found {len(results)} oil-relevant candidates."
            else:
                st.session_state["search_message"] = (
                    "No relevant oil market found. Paste a live Polymarket slug manually."
                )
        except Exception as exc:  # noqa: BLE001
            st.session_state["search_results"] = []
            st.session_state["search_message"] = f"Search failed: {exc}"

search_results = st.session_state.get("search_results", [])
search_message = st.session_state.get("search_message")
if search_message:
    render_status_line([search_message])

if search_results:
    st.markdown("#### Search candidates")
    search_df = build_search_table(search_results)
    st.dataframe(search_df, use_container_width=True, hide_index=True, height=190)

    label_to_slug: dict[str, str] = {}
    options: list[str] = []
    for item in search_results:
        slug = str(item.get("slug", "")).strip()
        if not slug:
            continue
        label = f"{parse_market_title(item)} | {slug} | {parse_market_status(item)}"
        options.append(label)
        label_to_slug[label] = slug
    if options:
        selected = st.selectbox("Select candidate slug", options=options)
        if st.button("Use this market"):
            st.session_state["market_slug"] = label_to_slug[selected]
            st.rerun()

warnings: list[str] = []
market_data: dict[str, Any] | None = None
market_slug = st.session_state["market_slug"].strip()

if market_slug:
    try:
        market_data = fetch_polymarket_market_by_slug(market_slug)
    except Exception:  # noqa: BLE001
        warnings.append(f"Slug not found: {market_slug}. Use manual search to pick a live oil market.")
else:
    warnings.append("Paste a live market slug, or use manual search.")

if market_data is not None:
    try:
        market_title = parse_market_title(market_data)
        market_status = parse_market_status(market_data)
        poly_prob = parse_yes_probability(market_data)
        market_expiry = extract_expiry_from_market(market_data)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Market parse error: {exc}")
        market_data = None

if market_data is not None:
    try:
        crude_price = get_crude_price()

        if st.session_state["use_market_expiry"] and market_expiry is not None:
            expiry_for_pricing: datetime | date = market_expiry
        else:
            expiry_for_pricing = datetime.combine(
                st.session_state["manual_expiry_date"], dt_time(23, 59, tzinfo=timezone.utc)
            )

        T = year_fraction_to_expiry(expiry_for_pricing, now_utc)
        fair_prob = tight_call_spread_fair_probability(
            S=crude_price,
            strike=strike,
            width=spread_width,
            T=T,
            r=risk_free_rate,
            sigma=implied_vol,
        )
        theoretical_delta = call_spread_delta(
            S=crude_price,
            strike=strike,
            width=spread_width,
            T=T,
            r=risk_free_rate,
            sigma=implied_vol,
        )

        row = {
            "timestamp": pd.Timestamp(now_utc),
            "market_slug": market_slug,
            "market_title": market_title,
            "market_status": market_status,
            "crude_price": crude_price,
            "poly_prob": poly_prob,
            "fair_prob": fair_prob,
            "theoretical_delta": theoretical_delta,
        }
        if should_append_observation(history, row, now_utc):
            history = pd.concat([history, pd.DataFrame([row])], ignore_index=True)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Data refresh failed: {exc}")

history = add_analytics_columns(
    history,
    rolling_window=rolling_window,
    fair_gap_threshold=fair_gap_threshold,
    delta_gap_threshold=delta_gap_threshold,
)
st.session_state["history"] = history

render_status_line(warnings)

has_history = not history.empty

if has_history:
    latest = history.iloc[-1]
    prev = history.iloc[-2] if len(history) > 1 else None
    st.caption(f"{latest.get('market_title', 'market')} | slug: {latest.get('market_slug', 'n/a')}")
else:
    latest = None
    prev = None
    st.caption(f"Awaiting first print | slug: {market_slug if market_slug else 'n/a'}")

crude_change_text = "n/a"
if has_history and prev is not None and pd.notna(prev["crude_price"]) and pd.notna(latest["crude_price"]):
    crude_change_text = f"Δ {latest['crude_price'] - prev['crude_price']:+.2f}"

spread_low = strike - spread_width / 2.0
spread_high = strike + spread_width / 2.0
signal = str(latest.get("signal", "Neutral")) if has_history else "Neutral"
fair_gap = latest.get("fair_value_gap", np.nan) if has_history else np.nan
fair_gap_cents = fair_gap * 100.0 if pd.notna(fair_gap) else np.nan

kpi_cols = st.columns(4)
with kpi_cols[0]:
    render_kpi_card(
        "CL front month",
        format_price(latest["crude_price"]) if has_history else "—",
        crude_change_text if has_history else "awaiting price",
        COLOR_CRUDE,
    )
with kpi_cols[1]:
    render_kpi_card(
        "Poly $90+ yes",
        format_prob(latest["poly_prob"]) if has_history else "—",
        (f"{format_cents(latest['poly_prob'])} | {latest.get('market_status', 'unknown')}" if has_history else "awaiting market"),
        COLOR_POLY,
    )
with kpi_cols[2]:
    render_kpi_card(
        "Call spread FV",
        format_prob(latest["fair_prob"]) if has_history else "—",
        f"{spread_low:.1f} / {spread_high:.1f} | IV {implied_vol:.2f}",
        COLOR_THEO,
    )
with kpi_cols[3]:
    render_kpi_card(
        "Poly - Theo",
        ("—" if pd.isna(fair_gap_cents) else f"{fair_gap_cents:+.2f}c"),
        signal_subtext(signal) if has_history else "awaiting signal",
        signal_color(signal),
    )

chart_cols = st.columns([1.0, 1.2])
if has_history:
    with chart_cols[0]:
        st.plotly_chart(make_heartbeat_chart(history), use_container_width=True, config={"displayModeBar": False})
    with chart_cols[1]:
        scatter_fig, poly_slope_all, theo_slope_all = make_scatter_chart(history)
        st.plotly_chart(scatter_fig, use_container_width=True, config={"displayModeBar": False})
else:
    poly_slope_all = None
    theo_slope_all = None
    with chart_cols[0]:
        st.plotly_chart(
            make_empty_panel_chart("Heartbeat", "Awaiting first observation"),
            use_container_width=True,
            config={"displayModeBar": False},
        )
    with chart_cols[1]:
        st.plotly_chart(
            make_empty_panel_chart("Scatter / Slope / Delta", "Need at least two prints to fit slopes"),
            use_container_width=True,
            config={"displayModeBar": False},
        )

slope_ratio = "—"
if has_history and poly_slope_all is not None and theo_slope_all is not None and not np.isclose(theo_slope_all, 0.0):
    slope_ratio = f"{poly_slope_all / theo_slope_all:.2f}"

summary_cols = st.columns(4)
with summary_cols[0]:
    st.metric("Empirical delta (roll)", format_num(latest.get("empirical_delta_roll")) if has_history else "—")
with summary_cols[1]:
    st.metric("Theo spread delta", format_num(latest.get("theoretical_delta")) if has_history else "—")
with summary_cols[2]:
    st.metric("Delta gap", format_num(latest.get("delta_gap")) if has_history else "—")
with summary_cols[3]:
    st.metric("Slope ratio (Poly/Theo)", slope_ratio)

if not has_history:
    render_no_data_panel()

st.markdown("#### Observations")
table_cols = [
    "timestamp",
    "crude_price",
    "poly_prob",
    "fair_prob",
    "fair_value_gap",
    "empirical_delta_inst",
    "empirical_delta_roll",
    "theoretical_delta",
    "delta_gap",
    "signal",
]
if has_history:
    table_df = history[table_cols].copy()
    table_df["timestamp"] = pd.to_datetime(table_df["timestamp"], utc=True).dt.strftime("%Y-%m-%d %H:%M:%S")
else:
    table_df = pd.DataFrame(columns=table_cols)
st.dataframe(table_df.tail(250), use_container_width=True, hide_index=True, height=210)

download_df = history.copy() if has_history else pd.DataFrame(columns=history.columns)
if has_history:
    download_df["timestamp"] = pd.to_datetime(download_df["timestamp"], utc=True).dt.strftime("%Y-%m-%d %H:%M:%S%z")
st.download_button(
    "Download history CSV",
    data=download_df.to_csv(index=False).encode("utf-8"),
    file_name="oil_delta_history.csv",
    mime="text/csv",
    disabled=not has_history,
)

if st.session_state["auto_refresh"] and market_slug:
    time.sleep(st.session_state["polling_interval_seconds"])
    st.rerun()
