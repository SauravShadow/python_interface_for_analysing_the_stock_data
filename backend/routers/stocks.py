"""
routers/stocks.py — Stock search and watchlist endpoints
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from database import get_db
from models.watchlist import Watchlist
from schemas.stocks import StockResult, WatchlistItem
from services.flattrade import flattrade_service

router = APIRouter(prefix="/stocks", tags=["stocks"])


@router.get("/search")
async def search_stocks(q: str, exchange: str = "NSE") -> list[StockResult]:
    """Search NSE/BSE stocks by name or symbol."""
    if not flattrade_service.is_logged_in():
        raise HTTPException(status_code=401, detail="Not logged in")
    results = flattrade_service.search_stock(q, exchange)
    return [StockResult(**r) for r in results]


# ── Watchlist ──────────────────────────────────────────────────────────────────

@router.get("/watchlist")
async def get_watchlist(db: AsyncSession = Depends(get_db)) -> list[dict]:
    result = await db.execute(select(Watchlist).order_by(Watchlist.added_at.desc()))
    items = result.scalars().all()
    return [item.to_dict() for item in items]


@router.post("/watchlist")
async def add_to_watchlist(
    item: WatchlistItem, db: AsyncSession = Depends(get_db)
) -> dict:
    # Check if already exists
    result = await db.execute(
        select(Watchlist).where(Watchlist.tsym == item.tsym)
    )
    existing = result.scalar_one_or_none()
    if existing:
        return {"status": "exists", "item": existing.to_dict()}

    new_item = Watchlist(
        tsym=item.tsym,
        token=item.token,
        exchange=item.exchange,
        cname=item.cname,
    )
    db.add(new_item)
    await db.flush()
    return {"status": "added", "item": new_item.to_dict()}


@router.delete("/watchlist/{tsym}")
async def remove_from_watchlist(
    tsym: str, db: AsyncSession = Depends(get_db)
) -> dict:
    await db.execute(delete(Watchlist).where(Watchlist.tsym == tsym))
    return {"status": "removed", "tsym": tsym}
