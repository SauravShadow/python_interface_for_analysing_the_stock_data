"""
routers/ml.py — ML model training (Celery task), listing, prediction, deletion
"""
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from celery.result import AsyncResult

from database import get_db
from models.ml_model import MLModel
from schemas.ml import TrainRequest, PredictRequest, ModelSummary, ALL_FEATURES
from logger import get_logger
from services.ml_service import ml_service
from services.data_service import data_service
from worker import celery_app

log = get_logger("routers.ml")

router = APIRouter(prefix="/ml", tags=["ml"])


@router.get("/features")
async def list_features() -> list[str]:
    """Return all available feature names the frontend can offer."""
    return ALL_FEATURES


@router.post("/train")
async def train_model(req: TrainRequest):
    """
    Dispatch ML training to Celery worker.
    Returns task_id and model_id immediately.
    Poll GET /ml/tasks/{task_id} for progress and results.
    """
    from tasks.ml_tasks import train_model_task

    model_id = str(uuid.uuid4())
    train_params = {
        "symbol": req.symbol,
        "exchange": req.exchange,
        "interval": req.interval,
        "features": req.features,
        "model_type": req.model_type,
        "task": req.task,
        "split_ratio": req.split_ratio,
        "hyperparams": req.hyperparams,
        "filters": req.filters,
        "lookback_steps": req.lookback_steps,
        "date_from": getattr(req, "date_from", None),
        "date_to": getattr(req, "date_to", None),
    }
    task = train_model_task.delay(
        model_id=model_id,
        name=req.name,
        train_params=train_params,
    )
    return {"task_id": task.id, "model_id": model_id}


@router.get("/tasks/{task_id}")
async def get_task_status(task_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """
    Poll Celery task state. When state=SUCCESS, saves model metadata to DB
    on the first successful poll (idempotent via model_id existence check).
    """
    result = AsyncResult(task_id, app=celery_app)

    if result.state == "PENDING":
        return {"state": "PENDING", "msg": "Waiting for worker..."}

    if result.state == "PROGRESS":
        return {"state": "PROGRESS", **result.info}

    if result.state == "SUCCESS":
        data = result.result
        model_id = data["model_id"]

        # Save to DB on first SUCCESS poll (idempotent)
        existing = await db.execute(select(MLModel).where(MLModel.id == model_id))
        if existing.scalar_one_or_none() is None:
            ml_model = MLModel(
                id=model_id,
                name=data["name"],
                symbol=data["symbol"],
                exchange=data["exchange"],
                model_type=data["model_type"],
                task=data["task"],
                features=data["features_used"],
                hyperparams=data["hyperparams"],
                filters=data["filters"],
                metrics=data["metrics"],
                feature_importance=data["feature_importance"],
                model_path=data["model_path"],
                data_interval=data["interval"],
                train_from=data.get("date_from"),
                train_to=data.get("date_to"),
            )
            db.add(ml_model)
            await db.commit()

        return {"state": "SUCCESS", **data}

    if result.state == "FAILURE":
        return {"state": "FAILURE", "msg": str(result.result)}

    return {"state": result.state}


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


@router.get("/backtest/{model_id}")
async def backtest_model(model_id: str, n: int = 200, db: AsyncSession = Depends(get_db)) -> dict:
    """Run model on last N historical candles, return win rate + equity curve for evaluation."""
    result = await db.execute(select(MLModel).where(MLModel.id == model_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Model not found")
    if m.model_type == "lstm":
        return {"skipped": True, "reason": "LSTM backtest not yet supported"}

    import os
    import joblib as _joblib
    if not m.model_path or not os.path.exists(m.model_path):
        raise HTTPException(status_code=400, detail="Model file not found on disk")

    df = data_service.load_for_analysis(m.symbol, m.data_interval or "1min")
    if df is None or df.empty:
        raise HTTPException(status_code=404, detail=f"No data for symbol: {m.symbol}")

    valid_features = [f for f in (m.features or []) if f in df.columns]
    if not valid_features:
        raise HTTPException(status_code=400, detail="No valid features found in data")

    feat_df = df[valid_features].dropna()
    closes = df["close"].reindex(feat_df.index).values
    model = _joblib.load(m.model_path)

    # Use last n+1 rows (need next candle to evaluate each prediction)
    feat_df = feat_df.iloc[-(n + 1):]
    closes  = closes[-(n + 1):]

    signals: list = []
    equity_curve: list = []
    equity = 100.0

    for i in range(len(feat_df) - 1):
        X = feat_df.iloc[[i]][valid_features]
        pred = str(model.predict(X)[0])
        actual = "UP" if closes[i + 1] > closes[i] else "DOWN"
        is_directional = pred in ("UP", "DOWN")
        correct = is_directional and (pred == actual)
        if is_directional:
            equity += 1.0 if correct else -0.5
        dt = str(feat_df.index[i])
        signals.append({
            "datetime":  dt,
            "predicted": pred,
            "actual":    actual,
            "correct":   correct,
            "close":     round(float(closes[i]), 2),
        })
        equity_curve.append({"datetime": dt, "equity": round(equity, 2)})

    directional = [s for s in signals if s["predicted"] in ("UP", "DOWN")]
    total   = len(directional)
    correct_count = sum(1 for s in directional if s["correct"])
    return {
        "total":        total,
        "correct":      correct_count,
        "win_rate":     round(correct_count / total * 100, 2) if total else 0.0,
        "equity_curve": equity_curve,
        "signals":      signals[-50:],
    }


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
