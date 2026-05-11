"""
models/ml_model.py — Trained ML model metadata
The actual model file is saved to disk; this table stores metadata + metrics.
"""
import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, JSON, Float
from sqlalchemy.orm import Mapped, mapped_column
from database import Base


class MLModel(Base):
    __tablename__ = "ml_models"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    symbol: Mapped[str] = mapped_column(String(50), nullable=False)
    exchange: Mapped[str] = mapped_column(String(10), nullable=False, default="NSE")
    # e.g. "random_forest", "xgboost", "lstm", "linear_regression"
    model_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # "regression" or "classification"
    task: Mapped[str] = mapped_column(String(20), nullable=False)
    # List of feature names used
    features: Mapped[list] = mapped_column(JSON, nullable=False)
    # Hyperparameters used
    hyperparams: Mapped[dict] = mapped_column(JSON, nullable=False)
    # Filters applied during training (same as analysis filters)
    filters: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # Training metrics: {"rmse": 0.02, "r2": 0.85, "mae": 0.015} or {"accuracy": 0.72, "f1": 0.70}
    metrics: Mapped[dict] = mapped_column(JSON, nullable=True)
    # Feature importance dict {"feature_name": importance_value}
    feature_importance: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Absolute path to the saved model file (.pkl or SavedModel dir)
    model_path: Mapped[str] = mapped_column(String(512), nullable=True)
    # Source data interval e.g. "1min", "5min"
    data_interval: Mapped[str] = mapped_column(String(10), nullable=False, default="1min")
    # Training date range
    train_from: Mapped[str | None] = mapped_column(String(20), nullable=True)
    train_to: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "symbol": self.symbol,
            "exchange": self.exchange,
            "model_type": self.model_type,
            "task": self.task,
            "features": self.features,
            "hyperparams": self.hyperparams,
            "filters": self.filters,
            "metrics": self.metrics,
            "feature_importance": self.feature_importance,
            "model_path": self.model_path,
            "data_interval": self.data_interval,
            "train_from": self.train_from,
            "train_to": self.train_to,
            "created_at": self.created_at.isoformat(),
        }
