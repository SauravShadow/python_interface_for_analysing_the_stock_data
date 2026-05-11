"""
models/analysis.py — Saved stock analyses (config + results metadata)
"""
import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, JSON, Text
from sqlalchemy.orm import Mapped, mapped_column
from database import Base


class Analysis(Base):
    __tablename__ = "analyses"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # "single" or "compare"
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="single")
    # JSON list of symbol strings e.g. ["INFY-EQ", "TCS-EQ"]
    symbols: Mapped[list] = mapped_column(JSON, nullable=False)
    # Full filter + analysis type config
    config: Mapped[dict] = mapped_column(JSON, nullable=False)
    # Lightweight summary of results (for list view, not the full plot data)
    results_summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "mode": self.mode,
            "symbols": self.symbols,
            "config": self.config,
            "results_summary": self.results_summary,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
