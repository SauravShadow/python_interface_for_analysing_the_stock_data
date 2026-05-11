"""
models/watchlist.py — Saved stock watchlist
"""
import uuid
from datetime import datetime
from sqlalchemy import String, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from database import Base


class Watchlist(Base):
    __tablename__ = "watchlist"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    tsym: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    token: Mapped[str] = mapped_column(String(20), nullable=False)
    exchange: Mapped[str] = mapped_column(String(10), nullable=False)
    cname: Mapped[str] = mapped_column(String(255), nullable=True)
    added_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tsym": self.tsym,
            "token": self.token,
            "exchange": self.exchange,
            "cname": self.cname,
            "added_at": self.added_at.isoformat(),
        }
