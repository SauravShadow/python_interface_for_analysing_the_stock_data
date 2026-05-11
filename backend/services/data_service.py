"""
services/data_service.py — CSV download, management and resampling

Wraps FlatTrade_API-ReadyToUse data_manager functions and provides
generator-based progress streaming for SSE endpoints.
"""

import os
import sys
import time
import pandas as pd
from datetime import datetime, timedelta
from pathlib import Path
from typing import Generator, Optional

from config import settings
from services.flattrade import flattrade_service

# Ensure FlatTrade project is on path (flattrade.py does this, but be explicit)
_ft_path = settings.FLATTRADE_PROJECT_PATH
if _ft_path not in sys.path:
    sys.path.insert(0, _ft_path)

DATA_DIR = Path(_ft_path) / "data"


class DataService:

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _csv_path(self, symbol: str) -> Path:
        return DATA_DIR / f"{symbol.replace('/', '_')}.csv"

    def _load_csv(self, symbol: str) -> Optional[pd.DataFrame]:
        path = self._csv_path(symbol)
        if not path.exists():
            return None
        df = pd.read_csv(path, parse_dates=["datetime"])
        df.set_index("datetime", inplace=True)
        df.sort_index(inplace=True)
        return df

    # ── Summary ────────────────────────────────────────────────────────────────

    def get_summary(self) -> list[dict]:
        if not DATA_DIR.exists():
            return []
        results = []
        base_files = [f for f in os.listdir(DATA_DIR)
                      if f.endswith(".csv") and "_" not in f.replace("-", "").replace(".", "")]

        for fname in sorted(os.listdir(DATA_DIR)):
            if not fname.endswith(".csv"):
                continue
            path = DATA_DIR / fname
            symbol = fname.replace(".csv", "")
            try:
                df = pd.read_csv(path, parse_dates=["datetime"])
                resampled = [
                    f.replace(".csv", "").split("_")[-1]
                    for f in os.listdir(DATA_DIR)
                    if f.startswith(symbol + "_") and f.endswith("min.csv")
                ] if "_" not in symbol else []
                results.append({
                    "symbol": symbol,
                    "records": len(df),
                    "date_from": str(df["datetime"].min().date()) if len(df) else None,
                    "date_to": str(df["datetime"].max().date()) if len(df) else None,
                    "size_kb": round(path.stat().st_size / 1024, 1),
                    "resampled_versions": resampled,
                    "last_updated": datetime.fromtimestamp(
                        path.stat().st_mtime
                    ).isoformat(),
                })
            except Exception:
                continue
        return results

    def delete_symbol(self, symbol: str) -> bool:
        path = self._csv_path(symbol)
        if path.exists():
            path.unlink()
            # Also remove resampled versions
            for f in DATA_DIR.glob(f"{symbol}_*min.csv"):
                f.unlink()
            return True
        return False

    # ── Download (yields SSE events) ───────────────────────────────────────────

    def download_stocks_stream(
        self, stocks: list[str], exchange: str, days: int, chunk_days: int
    ) -> Generator[str, None, None]:
        """
        Generator that yields SSE-formatted strings.
        Each line: "data: <json>\n\n"
        """
        import json

        api = flattrade_service.api
        total = len(stocks)

        for i, name in enumerate(stocks):
            name = name.strip().upper()
            yield f"data: {json.dumps({'type': 'search', 'stock': name, 'index': i, 'total': total})}\n\n"

            # Search for the stock
            ret = api.searchscrip(exchange=exchange, searchtext=name)
            time.sleep(0.2)

            if not ret or "values" not in ret:
                yield f"data: {json.dumps({'type': 'error', 'stock': name, 'msg': 'Not found'})}\n\n"
                continue

            values = ret["values"]
            chosen = (
                next((s for s in values if s["tsym"].upper() == f"{name}-EQ"), None)
                or next((s for s in values if "-EQ" in s["tsym"].upper()), None)
                or values[0]
            )
            symbol = chosen["tsym"]
            token = chosen["token"]

            yield f"data: {json.dumps({'type': 'found', 'stock': name, 'symbol': symbol, 'token': token})}\n\n"

            # Download in chunks
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            csv_path = self._csv_path(symbol)
            end_dt = datetime.now().replace(hour=23, minute=59, second=59)
            all_frames = []

            if csv_path.exists():
                existing = pd.read_csv(csv_path, parse_dates=["datetime"])
                last_date = existing["datetime"].max()
                start_dt = last_date + timedelta(minutes=1)
                all_frames.append(existing)
                yield f"data: {json.dumps({'type': 'incremental', 'symbol': symbol, 'from': str(last_date.date())})}\n\n"
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
                    total_new += len(df_chunk)
                    all_frames.append(df_chunk)
                    yield f"data: {json.dumps({'type': 'chunk', 'symbol': symbol, 'from': str(chunk_start.date()), 'to': str(chunk_end.date()), 'records': len(df_chunk)})}\n\n"
                chunk_start = chunk_end + timedelta(minutes=1)
                time.sleep(0.3)

            if all_frames:
                combined = pd.concat(all_frames, ignore_index=True)
                combined.drop_duplicates(subset=["datetime"], keep="last", inplace=True)
                combined.sort_values("datetime", inplace=True)
                combined.to_csv(csv_path, index=False)
                yield f"data: {json.dumps({'type': 'done', 'symbol': symbol, 'total': len(combined), 'new': total_new})}\n\n"

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
            rename = {"time": "datetime", "into": "open", "inth": "high",
                      "intl": "low", "intc": "close", "intv": "volume", "intvwap": "vwap"}
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
            print(f"[DataService] Chunk error: {e}")
            return None

    # ── Resample ───────────────────────────────────────────────────────────────

    def resample(self, symbol: str, interval_minutes: int, days: int) -> Optional[dict]:
        df = self._load_csv(symbol)
        if df is None:
            return None

        cutoff = df.index.max() - timedelta(days=days)
        df = df[df.index >= cutoff]

        agg = {"open": "first", "high": "max", "low": "min",
               "close": "last", "volume": "sum"}
        if "vwap" in df.columns:
            agg["vwap"] = "mean"

        resampled = (
            df.resample(f"{interval_minutes}min", label="left", closed="left")
            .agg(agg)
            .dropna(subset=["open", "close"])
            .reset_index()
        )

        out_path = DATA_DIR / f"{symbol.replace('/', '_')}_{interval_minutes}min.csv"
        resampled.to_csv(out_path, index=False)

        return {
            "symbol": symbol,
            "interval_minutes": interval_minutes,
            "records": len(resampled),
            "date_from": str(resampled["datetime"].min().date()),
            "date_to": str(resampled["datetime"].max().date()),
            "path": str(out_path),
        }

    # ── Load for analysis ──────────────────────────────────────────────────────

    def load_for_analysis(self, symbol: str, interval: str = "1min") -> Optional[pd.DataFrame]:
        """Load CSV data, selecting the appropriate interval file."""
        if interval == "1min":
            return self._load_csv(symbol)
        mins = interval.replace("min", "")
        path = DATA_DIR / f"{symbol.replace('/', '_')}_{mins}min.csv"
        if not path.exists():
            return None
        df = pd.read_csv(path, parse_dates=["datetime"])
        df.set_index("datetime", inplace=True)
        df.sort_index(inplace=True)
        return df


data_service = DataService()
