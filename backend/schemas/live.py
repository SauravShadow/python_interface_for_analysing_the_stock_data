from pydantic import BaseModel, Field
from typing import Optional


class AlertRequest(BaseModel):
    symbol: str
    exchange: str = "NSE"
    token: str
    above: Optional[float] = None   # trigger when price goes above this
    below: Optional[float] = None   # trigger when price goes below this
    note: Optional[str] = None


class LiveQuote(BaseModel):
    symbol: str
    exchange: str
    token: str
    ltp: float
    open: float
    high: float
    low: float
    close: float
    volume: int
    change_pct: float
    timestamp: str
