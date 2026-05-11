"""
services/analysis_service.py — Stock data filtering, indicator computation
and plot-data generation for the analysis pages.

Returns chart-ready data dicts (list of {x, y, ...}) that Recharts on the
frontend can consume directly — no image generation needed.
"""

import numpy as np
import pandas as pd
from datetime import timedelta
from typing import Optional

try:
    import ta
    HAS_TA = True
except ImportError:
    HAS_TA = False

from services.data_service import data_service


# ── Filter application ─────────────────────────────────────────────────────────

WEEKDAY_MAP = {
    "Monday": 0, "Tuesday": 1, "Wednesday": 2,
    "Thursday": 3, "Friday": 4
}


def apply_filters(df: pd.DataFrame, filters: dict) -> pd.DataFrame:
    """Apply all exclusion filters to a datetime-indexed DataFrame."""
    if df.empty:
        return df

    # Weekday exclusion
    excluded_days = [
        WEEKDAY_MAP[d] for d in filters.get("exclude_weekdays", [])
        if d in WEEKDAY_MAP
    ]
    if excluded_days:
        df = df[~df.index.dayofweek.isin(excluded_days)]

    # First of month
    if filters.get("exclude_first_of_month"):
        df = df[df.index.day != 1]

    # Last of month
    if filters.get("exclude_last_of_month"):
        df = df[~df.index.is_month_end]

    # Custom dates
    exclude_dates = filters.get("exclude_dates", [])
    if exclude_dates:
        ex_dates = set(pd.to_datetime(exclude_dates).date)
        df = df[~df.index.normalize().isin(pd.to_datetime(list(ex_dates)))]

    # Session time filter
    session = filters.get("session")
    if session and "-" in session:
        start_t, end_t = session.split("-")
        df = df.between_time(start_t.strip(), end_t.strip())

    # Date range
    if filters.get("date_from"):
        df = df[df.index >= pd.Timestamp(filters["date_from"])]
    if filters.get("date_to"):
        df = df[df.index <= pd.Timestamp(filters["date_to"]) + timedelta(days=1)]

    return df


# ── Technical Indicators ───────────────────────────────────────────────────────

def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Add common technical indicators using the `ta` library."""
    if not HAS_TA or df.empty:
        return df
    try:
        df = df.copy()
        # Trend
        df["sma_20"] = ta.trend.sma_indicator(df["close"], window=20)
        df["ema_9"]  = ta.trend.ema_indicator(df["close"], window=9)
        df["ema_21"] = ta.trend.ema_indicator(df["close"], window=21)
        # MACD
        macd = ta.trend.MACD(df["close"])
        df["macd"]        = macd.macd()
        df["macd_signal"] = macd.macd_signal()
        df["macd_hist"]   = macd.macd_diff()
        # RSI
        df["rsi_14"] = ta.momentum.rsi(df["close"], window=14)
        # Bollinger
        bb = ta.volatility.BollingerBands(df["close"], window=20)
        df["bb_upper"] = bb.bollinger_hband()
        df["bb_lower"] = bb.bollinger_lband()
        df["bb_width"] = bb.bollinger_wband()
        # ATR
        df["atr_14"] = ta.volatility.average_true_range(
            df["high"], df["low"], df["close"], window=14
        )
        # Volume
        df["obv"] = ta.volume.on_balance_volume(df["close"], df["volume"])
        if "vwap" not in df.columns:
            df["vwap"] = ta.volume.volume_weighted_average_price(
                df["high"], df["low"], df["close"], df["volume"]
            )
    except Exception as e:
        print(f"[AnalysisService] Indicator error: {e}")
    return df


# ── Individual analysis generators ────────────────────────────────────────────

def _returns_analysis(df: pd.DataFrame) -> dict:
    df = df.copy()
    df["returns"] = df["close"].pct_change() * 100
    clean = df["returns"].dropna()
    hist, bins = np.histogram(clean, bins=50)
    series_df = df[["returns", "close"]].dropna().reset_index()
    return {
        "type": "returns",
        "histogram": [
            {"bin": round(float(b), 4), "count": int(c)}
            for b, c in zip(bins[:-1], hist)
        ],
        "stats": {
            "mean": round(float(clean.mean()), 4),
            "std":  round(float(clean.std()), 4),
            "skew": round(float(clean.skew()), 4),
            "kurt": round(float(clean.kurt()), 4),
            "min":  round(float(clean.min()), 4),
            "max":  round(float(clean.max()), 4),
        },
        "series": [
            {
                "datetime": str(r["datetime"]),
                "daily_return": round(float(r["returns"]), 4),
                "close": round(float(r["close"]), 2),
            }
            for _, r in series_df.iterrows()
        ],
    }


def _volatility_analysis(df: pd.DataFrame) -> dict:
    df = df.copy()
    df["returns"] = df["close"].pct_change()
    df["rolling_vol"] = df["returns"].rolling(20).std() * np.sqrt(252) * 100
    series = df[["rolling_vol"]].dropna().reset_index()
    return {
        "type": "volatility",
        "rolling_vol": [
            {"datetime": str(r["datetime"]), "value": round(float(r["rolling_vol"]), 4)}
            for _, r in series.iterrows()
        ],
        "current_annualized_vol": round(float(series["rolling_vol"].iloc[-1]), 2)
        if len(series) else None,
    }


def _technicals_analysis(df: pd.DataFrame) -> dict:
    df = add_indicators(df)
    cols = ["close", "sma_20", "ema_9", "ema_21",
            "bb_upper", "bb_lower", "macd", "macd_signal",
            "macd_hist", "rsi_14", "atr_14"]
    available = [c for c in cols if c in df.columns]
    df_out = df[available].dropna(how="all").reset_index()

    candles = []
    for _, row in df_out.iterrows():
        entry = {"datetime": str(row["datetime"])}
        for col in available:
            if pd.notna(row.get(col)):
                entry[col] = round(float(row[col]), 4)
        candles.append(entry)

    return {"type": "technicals", "data": candles}


def _volume_analysis(df: pd.DataFrame) -> dict:
    df = df.copy()
    df["vol_ma20"] = df["volume"].rolling(20).mean()
    df["vol_ratio"] = df["volume"] / df["vol_ma20"]
    series = df[["volume", "vol_ma20", "vol_ratio", "close"]].dropna().reset_index()
    return {
        "type": "volume",
        "data": [
            {
                "datetime": str(r["datetime"]),
                "volume": int(r["volume"]),
                "vol_ma20": round(float(r["vol_ma20"]), 0),
                "vol_ratio": round(float(r["vol_ratio"]), 2),
                "close": round(float(r["close"]), 2),
            }
            for _, r in series.iterrows()
        ],
    }


def _patterns_analysis(df: pd.DataFrame) -> dict:
    df = df.copy()
    df["returns"] = df["close"].pct_change() * 100
    df["hour"] = df.index.hour
    df["dow"]  = df.index.dayofweek  # 0=Mon

    # Time-of-day heatmap (average return per hour)
    hourly = df.groupby("hour")["returns"].mean().reset_index()
    hourly_data = [
        {"hour": int(r["hour"]), "avg_return": round(float(r["returns"]), 4)}
        for _, r in hourly.iterrows()
    ]

    # Day-of-week returns
    day_labels = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    dow = df.groupby("dow")["returns"].agg(["mean", "std", "count"]).reset_index()
    dow_data = [
        {
            "day": day_labels[int(r["dow"])] if int(r["dow"]) < 5 else str(int(r["dow"])),
            "avg_return": round(float(r["mean"]), 4),
            "std": round(float(r["std"]), 4),
            "count": int(r["count"]),
        }
        for _, r in dow.iterrows()
    ]

    return {
        "type": "patterns",
        "hourly": hourly_data,
        "day_of_week": dow_data,
    }


def _drawdown_analysis(df: pd.DataFrame) -> dict:
    close = df["close"].dropna()
    cummax = close.cummax()
    drawdown = ((close - cummax) / cummax * 100).reset_index()
    drawdown.columns = ["datetime", "drawdown"]
    max_dd = float(drawdown["drawdown"].min())
    return {
        "type": "drawdown",
        "data": [
            {"datetime": str(r["datetime"]), "drawdown": round(float(r["drawdown"]), 4)}
            for _, r in drawdown.iterrows()
        ],
        "max_drawdown_pct": round(max_dd, 4),
    }


def _comparison_analysis(dfs: dict[str, pd.DataFrame]) -> dict:
    """Multi-stock comparison: normalized prices + correlation."""
    normalized = {}
    for sym, df in dfs.items():
        s = df["close"].dropna()
        normalized[sym] = (s / s.iloc[0] * 100).rename(sym)

    # Align on common index
    combined = pd.concat(normalized.values(), axis=1).dropna()
    symbols = list(combined.columns)

    # Normalized price series
    price_data = [
        {"datetime": str(idx), **{sym: round(float(combined.loc[idx, sym]), 2) for sym in symbols}}
        for idx in combined.index
    ]

    # Correlation matrix
    returns_df = combined.pct_change().dropna()
    corr = returns_df.corr()
    corr_data = [
        {"symbol_a": a, "symbol_b": b, "correlation": round(float(corr.loc[a, b]), 4)}
        for a in symbols for b in symbols
    ]

    # Beta vs first symbol (benchmark)
    benchmark = symbols[0]
    betas = {}
    bench_ret = returns_df[benchmark]
    for sym in symbols[1:]:
        sym_ret = returns_df[sym]
        cov = np.cov(sym_ret, bench_ret)[0][1]
        var = np.var(bench_ret)
        betas[sym] = round(cov / var, 4) if var else None

    return {
        "type": "comparison",
        "symbols": symbols,
        "normalized_prices": price_data,
        "correlation": corr_data,
        "beta_vs_benchmark": betas,
        "benchmark": benchmark,
    }


def _price_analysis(df: pd.DataFrame) -> dict:
    """Return OHLCV data sampled to at most 2000 points for a clean price chart."""
    sample = df.reset_index()
    if len(sample) > 2000:
        step = max(1, len(sample) // 2000)
        sample = sample.iloc[::step]
    return {
        "type": "price",
        "data": [
            {
                "datetime": str(r["datetime"]),
                "open":   round(float(r["open"]),   2),
                "high":   round(float(r["high"]),   2),
                "low":    round(float(r["low"]),    2),
                "close":  round(float(r["close"]),  2),
                "volume": int(r["volume"]),
            }
            for _, r in sample.iterrows()
        ],
    }


# ── Main entry point ───────────────────────────────────────────────────────────

ANALYSIS_MAP = {
    "price":      _price_analysis,
    "returns":    _returns_analysis,
    "volatility": _volatility_analysis,
    "technicals": _technicals_analysis,
    "volume":     _volume_analysis,
    "patterns":   _patterns_analysis,
    "drawdown":   _drawdown_analysis,
}


class AnalysisService:

    def run(
        self,
        mode: str,
        symbols: list[str],
        exchange: str,
        filters: dict,
        analysis_types: list[str],
    ) -> dict:
        interval = filters.get("interval", "1min")

        if mode == "compare":
            dfs = {}
            for sym in symbols:
                df = data_service.load_for_analysis(sym, interval)
                if df is not None and not df.empty:
                    dfs[sym] = apply_filters(df, filters)
            if not dfs:
                return {"error": "No data available for the requested symbols"}
            results = [_comparison_analysis(dfs)]
            # Also run per-symbol analyses that make sense
            for sym, df in dfs.items():
                for atype in analysis_types:
                    if atype in ANALYSIS_MAP and atype not in ("drawdown",):
                        try:
                            r = ANALYSIS_MAP[atype](df)
                            r["symbol"] = sym
                            results.append(r)
                        except Exception:
                            pass
            return {"mode": "compare", "symbols": symbols, "results": results}

        else:  # single
            sym = symbols[0]
            df = data_service.load_for_analysis(sym, interval)
            if df is None or df.empty:
                return {"error": f"No data for {sym}. Download it first."}
            df = apply_filters(df, filters)
            if df.empty:
                return {"error": "All data was filtered out. Relax your filters."}

            flat: dict = {
                "symbol": sym,
                "filtered_records": len(df),
                "date_from": str(df.index.min().date()),
                "date_to": str(df.index.max().date()),
                "avg_close": round(float(df["close"].mean()), 2),
            }
            for atype in analysis_types:
                if atype in ANALYSIS_MAP:
                    try:
                        flat[atype] = ANALYSIS_MAP[atype](df)
                    except Exception as e:
                        flat[atype] = {"error": str(e)}

            return flat


analysis_service = AnalysisService()
