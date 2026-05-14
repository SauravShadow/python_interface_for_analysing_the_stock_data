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
