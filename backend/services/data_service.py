"""
services/data_service.py — Stock data download, management and resampling.

Storage backend: TimescaleDB via ohlcv_store (replaces CSV files).
The public interface is unchanged for callers — they still receive
datetime-indexed pandas DataFrames from load_for_analysis().
"""

import json
import time
from datetime import datetime, timedelta
from typing import Generator, Optional

import pandas as pd

from logger import get_logger
from services.flattrade import flattrade_service
from services import ohlcv_store

log = get_logger("services.data_service")


class DataService:

    # ── Summary ────────────────────────────────────────────────────────────────

    def get_summary(self) -> list[dict]:
        """Return per-symbol metadata from TimescaleDB (replaces filesystem scan)."""
        return ohlcv_store.get_summary()

    def delete_symbol(self, symbol: str, exchange: str = "NSE") -> bool:
        """Delete all OHLCV data for a symbol from TimescaleDB."""
        return ohlcv_store.delete_symbol(symbol, exchange)

    # ── Download (yields SSE events) ───────────────────────────────────────────

    def download_stocks_stream(
        self, stocks: list[str], exchange: str, days: int, chunk_days: int
    ) -> Generator[str, None, None]:
        """
        Generator that yields SSE-formatted strings.
        Downloads from FlatTrade API and upserts into TimescaleDB.
        """
        api = flattrade_service.api
        total = len(stocks)

        for i, name in enumerate(stocks):
            name = name.strip().upper()
            yield f"data: {json.dumps({'type': 'search', 'stock': name, 'index': i, 'total': total})}\n\n"

            results = flattrade_service.search_stock(name, exchange)
            time.sleep(0.2)

            if not results:
                yield f"data: {json.dumps({'type': 'error', 'stock': name, 'msg': 'Not found'})}\n\n"
                continue

            chosen = results[0]
            symbol = chosen["tsym"]
            token = chosen["token"]

            yield f"data: {json.dumps({'type': 'found', 'stock': name, 'symbol': symbol, 'token': token})}\n\n"

            end_dt = datetime.now().replace(hour=23, minute=59, second=59)
            last_dt = ohlcv_store.get_last_datetime(symbol, exchange)

            if last_dt is not None:
                start_dt = last_dt + timedelta(minutes=1)
                yield f"data: {json.dumps({'type': 'incremental', 'symbol': symbol, 'from': str(last_dt.date())})}\n\n"
            else:
                start_dt = end_dt - timedelta(days=days)
                yield f"data: {json.dumps({'type': 'fresh', 'symbol': symbol, 'days': days})}\n\n"

            if start_dt >= end_dt:
                yield f"data: {json.dumps({'type': 'up_to_date', 'symbol': symbol})}\n\n"
                continue

            chunk_start = start_dt
            total_new = 0
            while chunk_start < end_dt:
                chunk_end = min(chunk_start + timedelta(days=chunk_days), end_dt)
                df_chunk = self._fetch_chunk(api, exchange, token, chunk_start, chunk_end)
                if df_chunk is not None and not df_chunk.empty:
                    inserted = ohlcv_store.upsert_dataframe(symbol, exchange, df_chunk)
                    total_new += inserted
                    yield f"data: {json.dumps({'type': 'chunk', 'symbol': symbol, 'from': str(chunk_start.date()), 'to': str(chunk_end.date()), 'records': len(df_chunk)})}\n\n"
                chunk_start = chunk_end + timedelta(minutes=1)
                time.sleep(0.3)

            total_stored = ohlcv_store.get_last_datetime(symbol, exchange)
            yield f"data: {json.dumps({'type': 'done', 'symbol': symbol, 'new': total_new})}\n\n"

        yield f"data: {json.dumps({'type': 'complete', 'total_stocks': total})}\n\n"

    def _fetch_chunk(self, api, exchange, token, start_dt, end_dt) -> Optional[pd.DataFrame]:
        try:
            ret = api.get_time_price_series(
                exchange=exchange, token=token,
                starttime=int(start_dt.timestamp()), endtime=int(end_dt.timestamp())
            )
            if not ret:
                return None
            df = pd.DataFrame(ret)
            rename = {
                "time": "datetime", "into": "open", "inth": "high",
                "intl": "low", "intc": "close", "intv": "volume", "intvwap": "vwap",
            }
            df.rename(columns={k: v for k, v in rename.items() if k in df.columns}, inplace=True)
            for col in ["open", "high", "low", "close", "volume", "vwap"]:
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors="coerce")
            if "datetime" in df.columns:
                df["datetime"] = pd.to_datetime(
                    df["datetime"], format="%d-%m-%Y %H:%M:%S", errors="coerce"
                )
            df.dropna(subset=["datetime"], inplace=True)
            df.sort_values("datetime", inplace=True)
            return df
        except Exception as e:
            log.error("Chunk parse error: %s", e, exc_info=True)
            return None

    # ── Resample ───────────────────────────────────────────────────────────────

    def resample(self, symbol: str, exchange: str, interval_minutes: int) -> Optional[dict]:
        """
        Resample via TimescaleDB time_bucket — no file created, result is live from DB.
        exchange param added (was not present in old CSV version).
        """
        df = ohlcv_store.load_resampled(symbol, exchange, interval_minutes)
        if df is None:
            return None
        return {
            "symbol": symbol,
            "exchange": exchange,
            "interval_minutes": interval_minutes,
            "records": len(df),
            "date_from": str(df.index.min().date()),
            "date_to": str(df.index.max().date()),
        }

    # ── Load for analysis ──────────────────────────────────────────────────────

    def load_for_analysis(
        self,
        symbol: str,
        exchange: str,
        interval: str = "1min",
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Optional[pd.DataFrame]:
        """
        Load OHLCV data as a datetime-indexed DataFrame.
        For interval='1min': direct SELECT from stock_ohlcv.
        For all other intervals: TimescaleDB time_bucket resampling.
        """
        if interval == "1min":
            return ohlcv_store.load_1min(symbol, exchange, date_from, date_to)
        mins_str = interval.replace("min", "")
        try:
            interval_minutes = int(mins_str)
        except ValueError:
            log.error("Invalid interval '%s' — expected format like '5min'", interval)
            return None
        return ohlcv_store.load_resampled(
            symbol, exchange, interval_minutes, date_from, date_to
        )


data_service = DataService()
