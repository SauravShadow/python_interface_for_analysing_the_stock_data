from pydantic import BaseModel, Field
from typing import Optional, Literal, Any


SUPPORTED_MODELS = Literal[
    "linear_regression",
    "ridge",
    "lasso",
    "random_forest",
    "xgboost",
    "lightgbm",
    "svm",
    "lstm",
]

SUPPORTED_TASKS = Literal["regression", "classification"]

ALL_FEATURES = [
    # Price
    "returns", "log_returns", "range_pct", "body_pct", "wick_ratio",
    # Moving Averages
    "sma_5", "sma_10", "sma_20", "ema_9", "ema_21",
    # Momentum
    "rsi_14", "macd", "macd_signal", "macd_hist", "stoch_k", "stoch_d",
    # Volatility
    "atr_14", "bb_width", "rolling_std_5", "rolling_std_10",
    # Volume
    "vol_change", "vol_vs_avg_20", "obv",
    # Time
    "hour", "day_of_week", "is_monday", "is_friday", "is_month_start", "is_month_end",
    # Lags
    "close_lag_1", "close_lag_2", "close_lag_3",
    "returns_lag_1", "returns_lag_2",
    "volume_lag_1",
]


class TrainRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    symbol: str
    exchange: str = "NSE"
    interval: str = "1min"
    features: list[str] = Field(..., min_length=1)
    model_type: SUPPORTED_MODELS = "random_forest"
    task: SUPPORTED_TASKS = "classification"
    # Train/test split ratio (0.8 = 80% train)
    split_ratio: float = Field(0.8, ge=0.5, le=0.95)
    # Optional hyperparameters (model-specific)
    hyperparams: dict[str, Any] = {}
    # Same filters as analysis
    filters: dict = {}
    # Date range for training data
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    # LSTM-specific
    lookback_steps: int = Field(10, ge=1, le=100)


class PredictRequest(BaseModel):
    model_id: str
    symbol: str
    horizon_candles: int = Field(5, ge=1, le=50)


class ModelSummary(BaseModel):
    id: str
    name: str
    symbol: str
    model_type: str
    task: str
    metrics: Optional[dict] = None
    created_at: str
