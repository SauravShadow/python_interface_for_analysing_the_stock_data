from pydantic import BaseModel, Field
from typing import Optional


class DownloadRequest(BaseModel):
    stocks: list[str] = Field(..., description="List of stock names e.g. ['INFY', 'TCS']")
    exchange: str = "NSE"
    days: int = Field(365, ge=1, le=3650)
    chunk_days: int = Field(50, ge=10, le=100)


class ResampleRequest(BaseModel):
    symbol: str = Field(..., description="e.g. INFY-EQ")
    interval_minutes: int = Field(..., ge=2, le=1440)
    days: int = Field(30, ge=1)


class DataSummaryItem(BaseModel):
    symbol: str
    records: int
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    size_kb: float
    resampled_versions: list[str] = []
    last_updated: Optional[str] = None
