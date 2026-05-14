"""
routers/data.py — Data download, resample and management endpoints
Uses SSE (Server-Sent Events) for streaming download progress.
"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from schemas.data import DownloadRequest, ResampleRequest, DataSummaryItem
from services.data_service import data_service
from services.flattrade import flattrade_service

router = APIRouter(prefix="/data", tags=["data"])


@router.get("/summary")
async def get_summary() -> list[DataSummaryItem]:
    """List all saved stock data with metadata (from TimescaleDB)."""
    items = data_service.get_summary()
    return [DataSummaryItem(**item) for item in items]


@router.post("/download")
async def download_stocks(req: DownloadRequest):
    """
    Stream download progress as Server-Sent Events.
    Frontend listens with EventSource or fetch + ReadableStream.
    """
    if not flattrade_service.is_logged_in():
        raise HTTPException(status_code=401, detail="Not logged in")

    def stream():
        yield from data_service.download_stocks_stream(
            stocks=req.stocks,
            exchange=req.exchange,
            days=req.days,
            chunk_days=req.chunk_days,
        )

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/resample")
async def resample_data(req: ResampleRequest) -> dict:
    """Resample stock data to any interval using TimescaleDB time_bucket."""
    result = data_service.resample(req.symbol, req.exchange, req.interval_minutes)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"No data found for {req.symbol}. Download it first."
        )
    return result


@router.delete("/{symbol}")
async def delete_symbol(
    symbol: str,
    exchange: str = Query("NSE", description="Exchange the symbol belongs to"),
) -> dict:
    """Delete a stock's OHLCV data from TimescaleDB."""
    removed = data_service.delete_symbol(symbol, exchange)
    if not removed:
        raise HTTPException(status_code=404, detail=f"No data found for {symbol}")
    return {"status": "deleted", "symbol": symbol, "exchange": exchange}
