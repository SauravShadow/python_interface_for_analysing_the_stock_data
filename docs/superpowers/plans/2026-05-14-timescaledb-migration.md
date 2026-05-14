# TimescaleDB Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CSV file storage for stock OHLCV data with a TimescaleDB hypertable backed by the existing PostgreSQL instance, eliminating 1-5s disk I/O on every analysis/ML request.

**Architecture:** A new sync SQLAlchemy engine (psycopg2) is added alongside the existing async engine (asyncpg) — DataService and its callers are synchronous (SSE generators, Celery tasks), so sync DB access is the right fit without refactoring the entire call stack. The `stock_ohlcv` TimescaleDB hypertable partitions on `datetime`, and all resampling moves to server-side `time_bucket()` SQL. The DataFrame interface that analysis and ML services consume is preserved — only the data source changes.

**Tech Stack:** TimescaleDB (PostgreSQL extension), psycopg2-binary, SQLAlchemy 2.0 (sync engine), pandas `read_sql`, TimescaleDB `time_bucket` / `first` / `last` aggregates.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `docker-compose.yml` | Switch postgres:15 → timescale/timescaledb:latest-pg15 |
| Modify | `backend/requirements.txt` | Add psycopg2-binary |
| Create | `backend/models/ohlcv.py` | SQLAlchemy ORM model for stock_ohlcv |
| Modify | `backend/models/__init__.py` | Export StockOHLCV so init_db picks it up |
| Modify | `backend/database.py` | Add sync_engine; extend init_db to enable extension + create hypertable |
| Create | `backend/services/ohlcv_store.py` | All synchronous DB I/O (upsert, load, summary, delete) |
| Modify | `backend/services/data_service.py` | Replace CSV logic with ohlcv_store calls |
| Modify | `backend/schemas/data.py` | Update DataSummaryItem (add exchange, remove file-specific fields) |
| Modify | `backend/services/analysis_service.py` | Pass exchange to load_for_analysis |
| Modify | `backend/services/ml_service.py` | Pass exchange to load_for_analysis; add exchange param to predict() |
| Modify | `backend/routers/data.py` | Add exchange query param to DELETE /{symbol} |
| Modify | `backend/routers/ml.py` | Pass exchange through to ml_service.predict() |
| Create | `backend/scripts/migrate_csv_to_db.py` | One-time: bulk-insert existing CSVs into TimescaleDB |

---

## Task 1: Switch Docker image to TimescaleDB

**Files:**
- Modify: `docker-compose.yml:4`

- [ ] **Step 1: Edit the postgres service image**

In `docker-compose.yml`, change line 4:
```yaml
# Before
    image: postgres:15
# After
    image: timescale/timescaledb:latest-pg15
```

The full postgres service block should look like:
```yaml
  postgres:
    image: timescale/timescaledb:latest-pg15
    restart: always
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-quantdash}
      POSTGRES_DB: ${POSTGRES_DB:-quantdash}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - quantdash-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 2: Verify the image exists**

```bash
docker pull timescale/timescaledb:latest-pg15
```
Expected: pulls successfully (may take a minute).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: switch postgres image to timescaledb:latest-pg15"
```

---

## Task 2: Add psycopg2-binary to requirements

**Files:**
- Modify: `backend/requirements.txt`

- [ ] **Step 1: Add psycopg2-binary after the asyncpg line**

In `backend/requirements.txt`, add after `asyncpg>=0.29.0`:
```
psycopg2-binary>=2.9.9
```

The database section should now read:
```
# Database
sqlalchemy[asyncio]>=2.0.0
asyncpg>=0.29.0
psycopg2-binary>=2.9.9
alembic>=1.13.0
```

- [ ] **Step 2: Verify install locally (if running outside Docker)**

```bash
cd backend
pip install psycopg2-binary>=2.9.9
```
Expected: installs cleanly (or already satisfied).

- [ ] **Step 3: Commit**

```bash
git add backend/requirements.txt
git commit -m "chore: add psycopg2-binary for sync SQLAlchemy engine"
```

---

## Task 3: Add StockOHLCV SQLAlchemy model

**Files:**
- Create: `backend/models/ohlcv.py`
- Modify: `backend/models/__init__.py`

- [ ] **Step 1: Create `backend/models/ohlcv.py`**

```python
"""
models/ohlcv.py — 1-minute OHLCV candle store (TimescaleDB hypertable)

The composite primary key (symbol, exchange, datetime) satisfies TimescaleDB's
requirement that any unique constraint includes the partition column (datetime).
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import String, Float, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from database import Base


class StockOHLCV(Base):
    __tablename__ = "stock_ohlcv"

    symbol: Mapped[str] = mapped_column(String(50), primary_key=True)
    exchange: Mapped[str] = mapped_column(String(10), primary_key=True)
    datetime: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), primary_key=True
    )
    open: Mapped[float] = mapped_column(Float, nullable=False)
    high: Mapped[float] = mapped_column(Float, nullable=False)
    low: Mapped[float] = mapped_column(Float, nullable=False)
    close: Mapped[float] = mapped_column(Float, nullable=False)
    volume: Mapped[float] = mapped_column(Float, nullable=False)
    vwap: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
```

- [ ] **Step 2: Update `backend/models/__init__.py`**

```python
"""Models package — re-exports all ORM models so database.py can import them."""
from .watchlist import Watchlist
from .analysis import Analysis
from .ml_model import MLModel
from .ohlcv import StockOHLCV

__all__ = ["Watchlist", "Analysis", "MLModel", "StockOHLCV"]
```

- [ ] **Step 3: Commit**

```bash
git add backend/models/ohlcv.py backend/models/__init__.py
git commit -m "feat: add StockOHLCV SQLAlchemy model for TimescaleDB hypertable"
```

---

## Task 4: Update database.py — add sync engine and TimescaleDB init

**Files:**
- Modify: `backend/database.py`

The sync engine uses the same credentials as the async engine, just with psycopg2 instead of asyncpg. `init_db()` is extended to enable the TimescaleDB extension and promote `stock_ohlcv` to a hypertable.

- [ ] **Step 1: Rewrite `backend/database.py`**

```python
"""
database.py — Async PostgreSQL setup with SQLAlchemy 2.0

Two engines:
  engine          — async (asyncpg), used by FastAPI route handlers
  sync_engine     — sync (psycopg2), used by DataService (SSE generators, Celery)
"""
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from config import settings


def _sync_url(async_url: str) -> str:
    """Convert asyncpg URL to psycopg2 URL."""
    return async_url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")


# ── Async engine (FastAPI route handlers) ─────────────────────────────────────
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)

AsyncSessionLocal = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)

# ── Sync engine (DataService — SSE generators and Celery tasks) ───────────────
sync_engine = create_engine(
    _sync_url(settings.DATABASE_URL),
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    """FastAPI dependency — yields a DB session per request."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    """
    Create all tables, enable TimescaleDB extension, and promote
    stock_ohlcv to a hypertable (all idempotent).
    """
    import models  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Enable extension and create hypertable in a separate connection
    # (DDL must run outside the metadata transaction)
    async with engine.begin() as conn:
        await conn.execute(
            text("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE")
        )
        await conn.execute(
            text(
                "SELECT create_hypertable("
                "  'stock_ohlcv', 'datetime',"
                "  if_not_exists => TRUE,"
                "  migrate_data => TRUE"
                ")"
            )
        )
```

- [ ] **Step 2: Verify syntax**

```bash
cd backend && python -c "from database import sync_engine, engine; print('OK')"
```
Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/database.py
git commit -m "feat: add sync_engine and TimescaleDB hypertable init to database.py"
```

---

## Task 5: Create ohlcv_store.py

**Files:**
- Create: `backend/services/ohlcv_store.py`

This module is the single source of truth for all OHLCV database I/O. All methods are synchronous — they use `sync_engine` (psycopg2) and are safe to call from SSE generators and Celery tasks.

- [ ] **Step 1: Create `backend/services/ohlcv_store.py`**

```python
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
```

- [ ] **Step 2: Verify syntax**

```bash
cd backend && python -c "from services.ohlcv_store import get_summary; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/services/ohlcv_store.py
git commit -m "feat: add ohlcv_store — sync TimescaleDB I/O for OHLCV data"
```

---

## Task 6: Rewrite DataService to use ohlcv_store

**Files:**
- Modify: `backend/services/data_service.py`

Key changes:
- `_load_csv` / `_csv_path` → deleted (replaced by ohlcv_store calls)
- `get_summary()` → delegates to `ohlcv_store.get_summary()`
- `delete_symbol(symbol)` → `delete_symbol(symbol, exchange)`
- `download_stocks_stream` → uses `ohlcv_store.get_last_datetime` + `ohlcv_store.upsert_dataframe` instead of CSV concat
- `resample()` → delegates to `ohlcv_store.load_resampled()`
- `load_for_analysis(symbol, interval)` → `load_for_analysis(symbol, exchange, interval)`, uses ohlcv_store

- [ ] **Step 1: Overwrite `backend/services/data_service.py`**

```python
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

from config import settings
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
```

- [ ] **Step 2: Verify syntax**

```bash
cd backend && python -c "from services.data_service import data_service; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/services/data_service.py
git commit -m "feat: rewrite DataService to use TimescaleDB via ohlcv_store (replace CSV)"
```

---

## Task 7: Update DataSummaryItem schema

**Files:**
- Modify: `backend/schemas/data.py`
- Modify: `backend/routers/data.py`

`DataSummaryItem` no longer has `size_kb` (no files) or `resampled_versions` (resampling is now live SQL). It gains `exchange`. The `ResampleRequest` no longer needs a `days` parameter (the DB holds all data; filtering by date range is done at analysis time, not resample time). The resample response no longer returns a `path`.

- [ ] **Step 1: Overwrite `backend/schemas/data.py`**

```python
from pydantic import BaseModel, Field
from typing import Optional


class DownloadRequest(BaseModel):
    stocks: list[str] = Field(..., description="List of stock names e.g. ['INFY', 'TCS']")
    exchange: str = "NSE"
    days: int = Field(365, ge=1, le=3650)
    chunk_days: int = Field(50, ge=10, le=100)


class ResampleRequest(BaseModel):
    symbol: str = Field(..., description="e.g. INFY-EQ")
    exchange: str = Field("NSE", description="e.g. NSE or BSE")
    interval_minutes: int = Field(..., ge=2, le=1440)


class DataSummaryItem(BaseModel):
    symbol: str
    exchange: str
    records: int
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    last_updated: Optional[str] = None
```

- [ ] **Step 2: Update `backend/routers/data.py`** to pass exchange to delete_symbol and resample

```python
"""
routers/data.py — Data download, resample and management endpoints
Uses SSE (Server-Sent Events) for streaming download progress.
"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from schemas.data import DownloadRequest, ResampleRequest, DataSummaryItem
from services.data_service import data_service
from services.flattrade import flattrade_service

router = APIRouter(prefix="/data", tags=["data"])


@router.get("/summary")
async def get_summary() -> list[DataSummaryItem]:
    """List all saved stock data with metadata (from TimescaleDB)."""
    items = data_service.get_summary()
    return [DataSummaryItem(**item) for item in items]


@router.post("/download")
async def download_stocks(req: DownloadRequest):
    """
    Stream download progress as Server-Sent Events.
    Frontend listens with EventSource or fetch + ReadableStream.
    """
    if not flattrade_service.is_logged_in():
        raise HTTPException(status_code=401, detail="Not logged in")

    def stream():
        yield from data_service.download_stocks_stream(
            stocks=req.stocks,
            exchange=req.exchange,
            days=req.days,
            chunk_days=req.chunk_days,
        )

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/resample")
async def resample_data(req: ResampleRequest) -> dict:
    """Resample stock data to any interval using TimescaleDB time_bucket."""
    result = data_service.resample(req.symbol, req.exchange, req.interval_minutes)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"No data found for {req.symbol}. Download it first."
        )
    return result


@router.delete("/{symbol}")
async def delete_symbol(
    symbol: str,
    exchange: str = Query("NSE", description="Exchange the symbol belongs to"),
) -> dict:
    """Delete a stock's OHLCV data from TimescaleDB."""
    removed = data_service.delete_symbol(symbol, exchange)
    if not removed:
        raise HTTPException(status_code=404, detail=f"No data found for {symbol}")
    return {"status": "deleted", "symbol": symbol, "exchange": exchange}
```

- [ ] **Step 3: Verify syntax**

```bash
cd backend && python -c "from routers.data import router; print('OK')"
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add backend/schemas/data.py backend/routers/data.py
git commit -m "feat: update data schema and router for TimescaleDB (add exchange, remove file fields)"
```

---

## Task 8: Update analysis_service.py to pass exchange

**Files:**
- Modify: `backend/services/analysis_service.py:477-500`

`load_for_analysis` now requires `exchange`. The `exchange` argument is already available in `AnalysisService.run()`.

- [ ] **Step 1: Update the `run()` method in `analysis_service.py`**

Find these two blocks in `AnalysisService.run()` (around lines 477-500) and update the `load_for_analysis` calls:

```python
# In the "compare" branch — change:
df = data_service.load_for_analysis(sym, interval)
# To:
df = data_service.load_for_analysis(sym, exchange, interval)
```

```python
# In the "single" branch — change:
df = data_service.load_for_analysis(sym, interval)
# To:
df = data_service.load_for_analysis(sym, exchange, interval)
```

After editing, the `run()` method body should look like:

```python
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
                df = data_service.load_for_analysis(sym, exchange, interval)
                if df is not None and not df.empty:
                    dfs[sym] = apply_filters(df, filters)
            if not dfs:
                return {"error": "No data available for the requested symbols"}
            results = [_comparison_analysis(dfs)]
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
            df = data_service.load_for_analysis(sym, exchange, interval)
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
```

- [ ] **Step 2: Verify syntax**

```bash
cd backend && python -c "from services.analysis_service import analysis_service; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/services/analysis_service.py
git commit -m "fix: pass exchange to data_service.load_for_analysis in analysis_service"
```

---

## Task 9: Update ml_service.py to pass exchange

**Files:**
- Modify: `backend/services/ml_service.py:267` (train_stream)
- Modify: `backend/services/ml_service.py:403-415` (predict)

`train_stream()` already has `exchange` in its signature but doesn't pass it to `load_for_analysis`. `predict()` needs exchange added to its signature.

- [ ] **Step 1: Fix `train_stream()` — line 267**

Change:
```python
df = data_service.load_for_analysis(symbol, interval)
```
To:
```python
df = data_service.load_for_analysis(symbol, exchange, interval)
```

- [ ] **Step 2: Update `predict()` signature and call — lines 403-415**

Change the method signature from:
```python
    def predict(
        self,
        model_path: str,
        model_type: str,
        symbol: str,
        interval: str,
        features: list[str],
        task: str,
        horizon: int = 5,
        lookback_steps: int = 10,
    ) -> dict:
        """Run inference on the most recent data."""
        df = data_service.load_for_analysis(symbol, interval)
```

To:
```python
    def predict(
        self,
        model_path: str,
        model_type: str,
        symbol: str,
        exchange: str,
        interval: str,
        features: list[str],
        task: str,
        horizon: int = 5,
        lookback_steps: int = 10,
    ) -> dict:
        """Run inference on the most recent data."""
        df = data_service.load_for_analysis(symbol, exchange, interval)
```

- [ ] **Step 3: Verify syntax**

```bash
cd backend && python -c "from services.ml_service import ml_service; print('OK')"
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add backend/services/ml_service.py
git commit -m "fix: pass exchange to load_for_analysis in ml_service train and predict"
```

---

## Task 10: Update ml router predict and backtest endpoints

**Files:**
- Modify: `backend/routers/ml.py` — the `/predict` and `/backtest/{model_id}` endpoints

`ml_service.predict()` now requires `exchange`. The ML router's predict endpoint reads `exchange` from the stored model metadata in PostgreSQL — it's already stored there from training.

- [ ] **Step 1: Read the full `backend/routers/ml.py`** to find the predict and backtest endpoints

```bash
grep -n "def predict\|def backtest\|def recent\|exchange" backend/routers/ml.py | head -30
```

- [ ] **Step 2: Update the predict endpoint** to extract exchange from stored model and pass to ml_service

Find the `@router.post("/predict")` endpoint and update it to fetch the model record from DB, get exchange from its metadata, and pass to `ml_service.predict()`. The pattern to find will look like:

```python
# Before (approximate):
result = ml_service.predict(
    model_path=...,
    model_type=...,
    symbol=...,
    interval=...,
    ...
)

# After:
result = ml_service.predict(
    model_path=...,
    model_type=...,
    symbol=...,
    exchange=model_record.metadata.get("exchange", "NSE"),
    interval=...,
    ...
)
```

Read the actual predict endpoint in ml.py (it wasn't fully read during planning) and make the minimal change: add `exchange=` pulled from the stored model's metadata dict.

- [ ] **Step 3: Verify syntax**

```bash
cd backend && python -c "from routers.ml import router; print('OK')"
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add backend/routers/ml.py
git commit -m "fix: pass exchange from stored model metadata to ml_service.predict"
```

---

## Task 11: Create CSV migration script

**Files:**
- Create: `backend/scripts/migrate_csv_to_db.py`

This one-time script reads all existing 1-minute CSVs from `/app/data/` and bulk-inserts them into `stock_ohlcv`. It must run after the Docker containers are up and TimescaleDB is initialized.

- [ ] **Step 1: Create `backend/scripts/` directory and script**

```bash
mkdir -p backend/scripts
touch backend/scripts/__init__.py
```

- [ ] **Step 2: Create `backend/scripts/migrate_csv_to_db.py`**

```python
#!/usr/bin/env python3
"""
scripts/migrate_csv_to_db.py

One-time migration: reads all 1-minute CSVs from the data directory
and bulk-inserts them into the stock_ohlcv TimescaleDB hypertable.

Resampled CSV files (those ending in _Nmin.csv) are skipped — resampling
is now done on-demand via TimescaleDB time_bucket.

Usage (run inside the backend container or with correct PYTHONPATH):
    python scripts/migrate_csv_to_db.py [--exchange NSE] [--data-dir /app/data]

Default exchange is NSE. If you have BSE data in a separate directory,
run the script a second time with --exchange BSE --data-dir /path/to/bse/data.
"""
import sys
import os
import argparse
from pathlib import Path

# Allow running from project root or from backend/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd
from config import settings
from services.ohlcv_store import upsert_dataframe


def is_resampled(stem: str) -> bool:
    """Return True if the CSV stem looks like a resampled file (e.g. SBIN-EQ_5min)."""
    parts = stem.split("_")
    return len(parts) > 1 and parts[-1].endswith("min") and parts[-1][:-3].isdigit()


def migrate(data_dir: Path, exchange: str) -> None:
    if not data_dir.exists():
        print(f"Data directory not found: {data_dir}")
        sys.exit(1)

    csv_files = sorted(data_dir.glob("*.csv"))
    base_files = [f for f in csv_files if not is_resampled(f.stem)]

    print(f"Found {len(csv_files)} CSV files total, {len(base_files)} base (1-min) files.")
    print(f"Exchange: {exchange}\n")

    total_inserted = 0
    errors = []

    for fpath in base_files:
        symbol = fpath.stem.replace("_", "/") if "/" in fpath.stem else fpath.stem
        # Restore original symbol format: CSVs use underscore for slash (e.g. NIFTY_50 → NIFTY/50)
        # But most NSE symbols don't have slashes — leave as-is if no slash was in original name
        symbol = fpath.stem  # use stem directly; slash symbols were stored as-is in DB
        print(f"  [{fpath.stem}] → symbol={symbol} ... ", end="", flush=True)
        try:
            df = pd.read_csv(fpath, parse_dates=["datetime"])
            if df.empty:
                print("empty, skipping")
                continue
            inserted = upsert_dataframe(symbol, exchange, df)
            total_inserted += inserted
            print(f"{len(df)} rows read, {inserted} inserted")
        except Exception as e:
            print(f"ERROR: {e}")
            errors.append((fpath.name, str(e)))

    print(f"\nMigration complete. Total rows inserted: {total_inserted}")
    if errors:
        print(f"\nErrors ({len(errors)}):")
        for fname, err in errors:
            print(f"  {fname}: {err}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate CSV data to TimescaleDB")
    parser.add_argument("--exchange", default="NSE", help="Exchange label (default: NSE)")
    parser.add_argument(
        "--data-dir",
        default=str(Path(settings.FLATTRADE_PROJECT_PATH) / "data"),
        help="Path to directory containing 1-min CSV files",
    )
    args = parser.parse_args()
    migrate(Path(args.data_dir), args.exchange)
```

- [ ] **Step 3: Verify syntax**

```bash
cd backend && python -c "import scripts.migrate_csv_to_db; print('OK')"
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/__init__.py backend/scripts/migrate_csv_to_db.py
git commit -m "feat: add one-time CSV → TimescaleDB migration script"
```

---

## Task 12: Rebuild Docker and run migration

This task wires everything together: stop old containers, rebuild images, restart, run the migration, and verify the API.

**Prerequisites:** PostgreSQL data volume (`postgres-data`) must be empty OR the old postgres:15 volume must be replaced with a fresh one for timescaledb to initialize cleanly. If you have no critical data in the existing postgres volume (watchlist, analyses, ml_models), it is simplest to drop and recreate the volume.

- [ ] **Step 1: Stop all containers**

```bash
cd /home/subaru/projects/python_dashboard
docker compose down
```

- [ ] **Step 2: Handle the postgres volume**

If the existing `postgres-data` volume was created with `postgres:15` (no TimescaleDB), it cannot be used directly with `timescale/timescaledb:latest-pg15`. You must recreate it:

```bash
docker volume rm python_dashboard_postgres-data
```

> **Note:** This deletes the existing watchlist, analyses, and ml_models data stored in PostgreSQL. If you want to keep it, export it first:
> ```bash
> docker compose up -d postgres
> docker compose exec postgres pg_dump -U postgres quantdash > backup.sql
> docker compose down
> docker volume rm python_dashboard_postgres-data
> ```
> Then restore after bringing containers back up.

- [ ] **Step 3: Rebuild and start all containers**

```bash
docker compose build backend
docker compose up -d
```

Wait ~30 seconds for PostgreSQL to initialize and for the backend to complete `init_db()` (which creates the hypertable).

- [ ] **Step 4: Confirm TimescaleDB extension is active**

```bash
docker compose exec postgres psql -U postgres -d quantdash -c "\dx"
```
Expected output includes: `timescaledb | ...`

- [ ] **Step 5: Confirm hypertable was created**

```bash
docker compose exec postgres psql -U postgres -d quantdash \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
```
Expected output: `stock_ohlcv`

- [ ] **Step 6: Run the CSV migration**

```bash
docker compose exec backend python scripts/migrate_csv_to_db.py
```
Expected: lines like `[SBIN-EQ] → symbol=SBIN-EQ ... 245000 rows read, 245000 inserted`

- [ ] **Step 7: Verify row counts match**

```bash
docker compose exec postgres psql -U postgres -d quantdash \
  -c "SELECT symbol, exchange, COUNT(*) as rows FROM stock_ohlcv GROUP BY symbol, exchange ORDER BY symbol;"
```
Expected: one row per symbol with row counts matching original CSV line counts.

- [ ] **Step 8: Smoke test the API**

```bash
# Check data summary (replaces filesystem scan)
curl -s http://localhost/api/data/summary | python3 -m json.tool | head -30

# Run an analysis (the key latency test)
curl -s -X POST http://localhost/api/analysis/run \
  -H "Content-Type: application/json" \
  -d '{"mode":"single","symbols":["SBIN-EQ"],"exchange":"NSE","filters":{"interval":"1min"},"analysis_types":["returns","volatility"]}' \
  | python3 -m json.tool | head -20
```
Expected: JSON response with `returns` and `volatility` keys, response time noticeably faster than before (sub-second for most datasets).

- [ ] **Step 9: Commit final verification note**

```bash
git add .
git commit -m "chore: TimescaleDB migration complete — CSV storage replaced with hypertable"
```

---

## Self-Review

### Spec Coverage

| Requirement | Covered by |
|-------------|-----------|
| Replace CSV with PostgreSQL/TimescaleDB | Tasks 1-6 |
| Faster dashboard data summary | Task 6 (get_summary → SQL COUNT/MIN/MAX) |
| Faster analysis loading | Task 6 (load_for_analysis → indexed SELECT) |
| Faster resampling | Task 5 (time_bucket SQL replaces pandas resample) |
| Keep exchange info per symbol | Tasks 3, 5, 6, 7, 8, 9, 10 |
| Migrate existing CSV data | Task 11 |
| End-to-end verification | Task 12 |

### Gaps / Notes

- **Frontend**: The `DataSummaryItem` schema removes `size_kb` and `resampled_versions`. The frontend data page (`/app/data/page.tsx`) will need minor updates to stop rendering those fields. This is cosmetic — the page will still work, just those columns will be empty/absent.
- **ML Router predict**: Task 10 instructs reading the actual endpoint before modifying it — the exact lines depend on ml.py content not fully read during planning. The pattern is clear: pull `exchange` from the stored MLModel record's metadata JSON field.
- **exchange defaults**: All endpoints default to `"NSE"` where exchange is not provided, preserving backward compatibility with any frontend code that doesn't send it yet.
- **Celery workers**: The migration script and ohlcv_store use `sync_engine`. Celery workers share the same codebase — `sync_engine` is safe to use in worker processes since psycopg2 uses thread-local connections.
