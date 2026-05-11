from pydantic import BaseModel, Field
from typing import Optional, Literal


class AnalysisFilter(BaseModel):
    # Weekday exclusions (0=Monday ... 4=Friday)
    exclude_weekdays: list[str] = Field(
        default=[],
        description="e.g. ['Monday', 'Friday']"
    )
    exclude_first_of_month: bool = False
    exclude_last_of_month: bool = False
    # Extra specific dates to exclude: ["2025-01-15", "2025-02-10"]
    exclude_dates: list[str] = []
    # Session time range: "09:15-15:30" (full day), "09:15-10:00" etc.
    session: Optional[str] = None
    # Source data interval
    interval: str = "1min"
    # Date range filter
    date_from: Optional[str] = None
    date_to: Optional[str] = None


class AnalysisRunRequest(BaseModel):
    mode: Literal["single", "compare"] = "single"
    symbols: list[str] = Field(..., min_length=1)
    exchange: str = "NSE"
    filters: AnalysisFilter = Field(default_factory=AnalysisFilter)
    # Which analysis types to compute
    analysis_types: list[str] = Field(
        default=["returns", "volatility", "technicals", "volume", "patterns", "drawdown"]
    )


class SaveAnalysisRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    mode: str = "single"
    symbols: list[str]
    config: dict
    results_summary: Optional[dict] = None
    # "new" = always create new, "update" = update existing by id
    action: Literal["new", "update"] = "new"
    existing_id: Optional[str] = None


class AnalysisSummary(BaseModel):
    id: str
    name: str
    mode: str
    symbols: list[str]
    created_at: str
    updated_at: str
    analysis_types: list[str] = []
