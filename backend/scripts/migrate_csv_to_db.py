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
        symbol = fpath.stem
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
