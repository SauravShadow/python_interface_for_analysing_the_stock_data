"""
services/ohlcv_store.py — Synchronous OHLCV storage for TimescaleDB.

All public functions use sync_engine (psycopg2) so they can be called
from SSE generators and Celery workers without async overhead.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pandas as pd
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from database import sync_engine
from logger import get_logger

log = get_logger("services.ohlcv_store")


def upsert_dataframe(symbol: str, exchange: str, df: pd.DataFrame) -> int:
    """
    Bulk-insert OHLCV rows, skipping duplicates (ON CONFLICT DO NOTHING).
    df must have columns: datetime (index or column), open, high, low, close, volume.
    vwap is optional.
    Returns the number of rows actually inserted.
    """
    from models.ohlcv import StockOHLCV

    working = df.reset_index() if df.index.name == "datetime" else df.copy()
    working["symbol"] = symbol
    working["exchange"] = exchange
    if "vwap" not in working.columns:
        working["vwap"] = None

    cols = ["symbol", "exchange", "datetime", "open", "high", "low", "close", "volume", "vwap"]
    records = (
        working[cols]
        .dropna(subset=["datetime", "open", "close"])
        .to_dict("records")
    )
    if not records:
        return 0

    stmt = pg_insert(StockOHLCV.__table__).values(records)
    stmt = stmt.on_conflict_do_nothing(
        index_elements=["symbol", "exchange", "datetime"]
    )
    with sync_engine.begin() as conn:
        result = conn.execute(stmt)
    return result.rowcount


def get_last_datetime(symbol: str, exchange: str) -> Optional[datetime]:
    """Return the most recent candle datetime, or None if symbol has no data."""
    sql = text(
        "SELECT MAX(datetime) FROM stock_ohlcv"
        " WHERE symbol = :sym AND exchange = :exch"
    )
    with sync_engine.connect() as conn:
        row = conn.execute(sql, {"sym": symbol, "exch": exchange}).fetchone()
    return row[0] if row and row[0] else None


def load_1min(
    symbol: str,
    exchange: str,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> Optional[pd.DataFrame]:
    """
    Load 1-minute OHLCV as a datetime-indexed DataFrame.
    Returns None when no data exists for the symbol.
    """
    where_parts = ["symbol = :sym", "exchange = :exch"]
    params: dict = {"sym": symbol, "exch": exchange}
    if date_from:
        where_parts.append("datetime >= :df")
        params["df"] = date_from
    if date_to:
        where_parts.append("datetime <= :dt")
        params["dt"] = date_to

    sql = text(
        "SELECT datetime, open, high, low, close, volume, vwap"
        " FROM stock_ohlcv"
        f" WHERE {' AND '.join(where_parts)}"
        " ORDER BY datetime"
    )
    with sync_engine.connect() as conn:
        df = pd.read_sql(sql, conn, params=params, parse_dates=["datetime"])

    if df.empty:
        return None
    df.set_index("datetime", inplace=True)
    return df


def load_resampled(
    symbol: str,
    exchange: str,
    interval_minutes: int,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> Optional[pd.DataFrame]:
    """
    Load resampled OHLCV using TimescaleDB time_bucket.
    Uses first/last/max/min/sum aggregates — no pandas resample needed.
    Returns None when no data exists.
    """
    where_parts = ["symbol = :sym", "exchange = :exch"]
    params: dict = {
        "sym": symbol,
        "exch": exchange,
        "bucket": f"{interval_minutes} minutes",
    }
    if date_from:
        where_parts.append("datetime >= :df")
        params["df"] = date_from
    if date_to:
        where_parts.append("datetime <= :dt")
        params["dt"] = date_to

    where_clause = " AND ".join(where_parts)
    sql = text(f"""
        SELECT
            time_bucket(:bucket, datetime) AS datetime,
            first(open,   datetime)        AS open,
            max(high)                      AS high,
            min(low)                       AS low,
            last(close,   datetime)        AS close,
            sum(volume)                    AS volume,
            avg(vwap)                      AS vwap
        FROM stock_ohlcv
        WHERE {where_clause}
        GROUP BY 1
        ORDER BY 1
    """)
    with sync_engine.connect() as conn:
        df = pd.read_sql(sql, conn, params=params, parse_dates=["datetime"])

    if df.empty:
        return None
    df.set_index("datetime", inplace=True)
    return df


def get_summary() -> list[dict]:
    """
    Return per-symbol metadata from the DB.
    Replaces the filesystem directory scan in the old get_summary().
    """
    sql = text("""
        SELECT
            symbol,
            exchange,
            COUNT(*)      AS records,
            MIN(datetime) AS date_from,
            MAX(datetime) AS date_to,
            MAX(datetime) AS last_updated
        FROM stock_ohlcv
        GROUP BY symbol, exchange
        ORDER BY symbol
    """)
    with sync_engine.connect() as conn:
        rows = conn.execute(sql).fetchall()

    return [
        {
            "symbol": r.symbol,
            "exchange": r.exchange,
            "records": r.records,
            "date_from": str(r.date_from.date()) if r.date_from else None,
            "date_to": str(r.date_to.date()) if r.date_to else None,
            "last_updated": r.last_updated.isoformat() if r.last_updated else None,
        }
        for r in rows
    ]


def delete_symbol(symbol: str, exchange: str) -> bool:
    """Delete all OHLCV rows for a symbol+exchange. Returns True if any rows deleted."""
    sql = text(
        "DELETE FROM stock_ohlcv WHERE symbol = :sym AND exchange = :exch"
    )
    with sync_engine.begin() as conn:
        result = conn.execute(sql, {"sym": symbol, "exch": exchange})
    return result.rowcount > 0
