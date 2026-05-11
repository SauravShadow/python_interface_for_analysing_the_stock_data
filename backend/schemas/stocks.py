from pydantic import BaseModel
from typing import Optional


class StockResult(BaseModel):
    tsym: str
    token: str
    exchange: str
    cname: Optional[str] = None


class WatchlistItem(BaseModel):
    tsym: str
    token: str
    exchange: str
    cname: Optional[str] = None
