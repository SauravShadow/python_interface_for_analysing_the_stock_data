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
