"""
routers/ml.py — ML model training (SSE stream), listing, prediction, deletion
"""
import uuid
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from database import get_db
from models.ml_model import MLModel
from schemas.ml import TrainRequest, PredictRequest, ModelSummary, ALL_FEATURES
from services.ml_service import ml_service
from services.data_service import data_service

router = APIRouter(prefix="/ml", tags=["ml"])


@router.get("/features")
async def list_features() -> list[str]:
    """Return all available feature names the frontend can offer."""
    return ALL_FEATURES


@router.post("/train")
async def train_model(req: TrainRequest, db: AsyncSession = Depends(get_db)):
    """
    Train a model. Returns an SSE stream of progress events.
    Final event type "done" contains metrics, feature_importance, and model_path.
    The router saves metadata to DB on the "done" event in-stream.
    """
    model_id = str(uuid.uuid4())

    async def stream():
        saved = False
        async for chunk in _async_train(model_id, req):
            yield chunk
            # Parse the final done event to persist to DB
            if not saved and b'"type": "done"' in chunk:
                import json
                try:
                    data = json.loads(chunk.decode().replace("data: ", "").strip())
                    if data.get("type") == "done":
                        ml_model = MLModel(
                            id=model_id,
                            name=req.name,
                            symbol=req.symbol,
                            exchange=req.exchange,
                            model_type=req.model_type,
                            task=req.task,
                            features=data.get("features_used", req.features),
                            hyperparams=req.hyperparams,
                            filters=req.filters,
                            metrics=data.get("metrics"),
                            feature_importance=data.get("feature_importance"),
                            model_path=data.get("model_path"),
                            data_interval=req.interval,
                            train_from=req.date_from,
                            train_to=req.date_to,
                        )
                        db.add(ml_model)
                        await db.commit()
                        saved = True
                except Exception as e:
                    print(f"[ML Router] DB save error: {e}")

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _async_train(model_id: str, req: TrainRequest):
    """Wrap the sync generator in an async generator."""
    import asyncio
    gen = ml_service.train_stream(
        model_id=model_id,
        symbol=req.symbol,
        exchange=req.exchange,
        interval=req.interval,
        features=req.features,
        model_type=req.model_type,
        task=req.task,
        split_ratio=req.split_ratio,
        hyperparams=req.hyperparams,
        filters=req.filters,
        lookback_steps=req.lookback_steps,
    )
    loop = asyncio.get_event_loop()
    for chunk in gen:
        yield chunk.encode()
        await asyncio.sleep(0)  # yield control to event loop


@router.get("/models")
async def list_models(
    symbol: str = None, db: AsyncSession = Depends(get_db)
) -> list[ModelSummary]:
    """List all trained models, optionally filtered by symbol."""
    q = select(MLModel).order_by(MLModel.created_at.desc())
    if symbol:
        q = q.where(MLModel.symbol == symbol)
    result = await db.execute(q)
    models = result.scalars().all()
    return [
        ModelSummary(
            id=m.id,
            name=m.name,
            symbol=m.symbol,
            model_type=m.model_type,
            task=m.task,
            metrics=m.metrics,
            created_at=m.created_at.isoformat(),
        )
        for m in models
    ]


@router.get("/models/{model_id}")
async def get_model(model_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Get full model metadata including feature importance and metrics."""
    result = await db.execute(select(MLModel).where(MLModel.id == model_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Model not found")
    return m.to_dict()


@router.post("/predict")
async def predict(req: PredictRequest, db: AsyncSession = Depends(get_db)) -> dict:
    """Run inference using a saved model."""
    result = await db.execute(select(MLModel).where(MLModel.id == req.model_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Model not found")
    if not m.model_path:
        raise HTTPException(status_code=400, detail="Model file path not recorded")

    prediction = ml_service.predict(
        model_path=m.model_path,
        model_type=m.model_type,
        symbol=req.symbol,
        interval=m.data_interval,
        features=m.features,
        task=m.task,
        horizon=req.horizon_candles,
        lookback_steps=m.hyperparams.get("lookback_steps", 10),
    )
    return prediction


@router.get("/recent-prices/{symbol}")
async def get_recent_prices(symbol: str, interval: str = "1min", n: int = 60) -> dict:
    """Return the last N closing prices for a symbol (used for prediction chart context)."""
    df = data_service.load_for_analysis(symbol, interval)
    if df is None or df.empty:
        raise HTTPException(status_code=404, detail=f"No data for symbol: {symbol}")
    tail = df.tail(n).reset_index()
    records = [
        {"datetime": str(row["datetime"]), "close": float(row["close"])}
        for _, row in tail.iterrows()
    ]
    return {"symbol": symbol, "prices": records}


@router.delete("/models/{model_id}")
async def delete_model(model_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Delete model record and its file."""
    import os
    result = await db.execute(select(MLModel).where(MLModel.id == model_id))
    m = result.scalar_one_or_none()
    if m and m.model_path and os.path.exists(m.model_path):
        os.remove(m.model_path)
    await db.execute(delete(MLModel).where(MLModel.id == model_id))
    return {"status": "deleted", "id": model_id}
