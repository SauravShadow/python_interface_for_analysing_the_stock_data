"""
services/ml_service.py — Model training, evaluation, persistence and inference.

Supported model types:
  Scikit-learn: linear_regression, ridge, lasso, svm, random_forest
  XGBoost:      xgboost
  LightGBM:     lightgbm
  TensorFlow:   lstm

Models are saved to settings.ML_MODELS_DIR.
Metadata (metrics, features, config) is stored in PostgreSQL via the router.
"""

import os
import json
import numpy as np
import pandas as pd
import joblib
from pathlib import Path
from typing import Optional, Generator
from datetime import timedelta

from config import settings
from services.data_service import data_service
from services.analysis_service import apply_filters, add_indicators

MODEL_DIR = Path(settings.ML_MODELS_DIR)
MODEL_DIR.mkdir(parents=True, exist_ok=True)


# ── Feature engineering ────────────────────────────────────────────────────────

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all possible features. Router decides which to use."""
    df = df.copy()
    c = df["close"]
    h = df["high"]
    l = df["low"]
    o = df["open"]
    v = df["volume"]

    # Price features
    df["returns"]     = c.pct_change()
    df["log_returns"] = np.log(c / c.shift(1))
    df["range_pct"]   = (h - l) / c
    df["body_pct"]    = abs(c - o) / c
    df["wick_ratio"]  = (h - l - abs(c - o)) / (h - l + 1e-9)

    # Moving averages
    for w in [5, 10, 20]:
        df[f"sma_{w}"] = c.rolling(w).mean()
    for w in [9, 21]:
        df[f"ema_{w}"] = c.ewm(span=w, adjust=False).mean()

    # Momentum (manual to avoid requiring ta)
    delta = c.diff()
    gain  = delta.clip(lower=0).rolling(14).mean()
    loss  = (-delta.clip(upper=0)).rolling(14).mean()
    df["rsi_14"] = 100 - 100 / (1 + gain / (loss + 1e-9))

    ema12 = c.ewm(span=12).mean()
    ema26 = c.ewm(span=26).mean()
    df["macd"]        = ema12 - ema26
    df["macd_signal"] = df["macd"].ewm(span=9).mean()
    df["macd_hist"]   = df["macd"] - df["macd_signal"]

    # Stochastic
    low14  = l.rolling(14).min()
    high14 = h.rolling(14).max()
    df["stoch_k"] = 100 * (c - low14) / (high14 - low14 + 1e-9)
    df["stoch_d"] = df["stoch_k"].rolling(3).mean()

    # Volatility
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    df["atr_14"] = tr.rolling(14).mean()
    df["rolling_std_5"]  = df["returns"].rolling(5).std()
    df["rolling_std_10"] = df["returns"].rolling(10).std()

    # Bollinger width
    sma20 = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    df["bb_width"] = (2 * std20) / sma20

    # Volume
    df["vol_change"]   = v.pct_change()
    df["vol_vs_avg_20"] = v / v.rolling(20).mean()
    df["obv"] = (np.sign(df["returns"]) * v).cumsum()

    # Time
    df["hour"]         = df.index.hour
    df["day_of_week"]  = df.index.dayofweek
    df["is_monday"]    = (df.index.dayofweek == 0).astype(int)
    df["is_friday"]    = (df.index.dayofweek == 4).astype(int)
    df["is_month_start"] = df.index.is_month_start.astype(int)
    df["is_month_end"]   = df.index.is_month_end.astype(int)

    # Lags
    for lag in [1, 2, 3]:
        df[f"close_lag_{lag}"]   = c.shift(lag)
        df[f"returns_lag_{lag}"] = df["returns"].shift(lag)
    df["volume_lag_1"] = v.shift(1)

    return df


def prepare_data(
    df: pd.DataFrame,
    features: list[str],
    task: str,
    split_ratio: float,
    lookback: int = 1,
) -> tuple:
    """
    Prepare X, y for training.
    For LSTM, reshapes X to (samples, timesteps, features).
    Returns (X_train, X_test, y_train, y_test, feature_cols).
    """
    df = engineer_features(df)

    # Target
    if task == "regression":
        df["target"] = df["close"].shift(-1)
    else:  # classification
        df["target"] = (df["close"].shift(-1) > df["close"]).astype(int)

    valid_features = [f for f in features if f in df.columns]
    df = df[valid_features + ["target"]].dropna()

    X = df[valid_features].values
    y = df["target"].values

    split_idx = int(len(X) * split_ratio)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]

    return X_train, X_test, y_train, y_test, valid_features


# ── Model factory ──────────────────────────────────────────────────────────────

def _build_sklearn(model_type: str, task: str, hp: dict):
    from sklearn.linear_model import LinearRegression, Ridge, Lasso
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
    from sklearn.svm import SVR, SVC

    if model_type == "linear_regression":
        return LinearRegression()
    if model_type == "ridge":
        return Ridge(alpha=hp.get("alpha", 1.0))
    if model_type == "lasso":
        return Lasso(alpha=hp.get("alpha", 0.01))
    if model_type == "random_forest":
        if task == "classification":
            return RandomForestClassifier(
                n_estimators=hp.get("n_estimators", 100),
                max_depth=hp.get("max_depth", None),
                random_state=42,
                n_jobs=-1,
            )
        return RandomForestRegressor(
            n_estimators=hp.get("n_estimators", 100),
            max_depth=hp.get("max_depth", None),
            random_state=42,
            n_jobs=-1,
        )
    if model_type == "svm":
        return SVC(kernel=hp.get("kernel", "rbf"), probability=True) \
               if task == "classification" else \
               SVR(kernel=hp.get("kernel", "rbf"))
    raise ValueError(f"Unknown sklearn model: {model_type}")


def _build_xgboost(task: str, hp: dict):
    import xgboost as xgb
    if task == "classification":
        return xgb.XGBClassifier(
            n_estimators=hp.get("n_estimators", 100),
            max_depth=hp.get("max_depth", 4),
            learning_rate=hp.get("learning_rate", 0.1),
            use_label_encoder=False,
            eval_metric="logloss",
            random_state=42,
        )
    return xgb.XGBRegressor(
        n_estimators=hp.get("n_estimators", 100),
        max_depth=hp.get("max_depth", 4),
        learning_rate=hp.get("learning_rate", 0.1),
        random_state=42,
    )


def _build_lightgbm(task: str, hp: dict):
    import lightgbm as lgb
    if task == "classification":
        return lgb.LGBMClassifier(
            n_estimators=hp.get("n_estimators", 100),
            learning_rate=hp.get("learning_rate", 0.1),
            num_leaves=hp.get("num_leaves", 31),
            random_state=42,
            verbose=-1,
        )
    return lgb.LGBMRegressor(
        n_estimators=hp.get("n_estimators", 100),
        learning_rate=hp.get("learning_rate", 0.1),
        num_leaves=hp.get("num_leaves", 31),
        random_state=42,
        verbose=-1,
    )


def _build_lstm(n_features: int, lookback: int, task: str, hp: dict):
    import tensorflow as tf
    from tensorflow import keras

    units      = hp.get("units", 64)
    dropout    = hp.get("dropout", 0.2)
    n_layers   = hp.get("lstm_layers", 2)

    model = keras.Sequential()
    for i in range(n_layers):
        ret_seq = (i < n_layers - 1)
        model.add(keras.layers.LSTM(
            units, return_sequences=ret_seq,
            input_shape=(lookback, n_features) if i == 0 else None
        ))
        model.add(keras.layers.Dropout(dropout))

    if task == "classification":
        model.add(keras.layers.Dense(1, activation="sigmoid"))
        model.compile(optimizer="adam", loss="binary_crossentropy", metrics=["accuracy"])
    else:
        model.add(keras.layers.Dense(1))
        model.compile(optimizer="adam", loss="mse", metrics=["mae"])

    return model


# ── Training ───────────────────────────────────────────────────────────────────

class MLService:

    def train_stream(
        self,
        model_id: str,
        symbol: str,
        exchange: str,
        interval: str,
        features: list[str],
        model_type: str,
        task: str,
        split_ratio: float,
        hyperparams: dict,
        filters: dict,
        lookback_steps: int = 10,
    ) -> Generator[str, None, None]:
        """Generator yielding SSE events during training."""
        import json as _json

        def _emit(event: dict) -> str:
            return f"data: {_json.dumps(event)}\n\n"

        yield _emit({"type": "start", "model_id": model_id, "model_type": model_type})

        try:
            # Load data
            yield _emit({"type": "progress", "msg": "Loading data..."})
            df = data_service.load_for_analysis(symbol, exchange, interval)
            if df is None or df.empty:
                yield _emit({"type": "error", "msg": f"No data for {symbol}"})
                return
            df = apply_filters(df, filters)
            if df.empty:
                yield _emit({"type": "error", "msg": "All data filtered out"})
                return

            yield _emit({"type": "progress", "msg": f"Loaded {len(df)} candles. Engineering features..."})
            X_train, X_test, y_train, y_test, valid_features = prepare_data(
                df, features, task, split_ratio, lookback_steps
            )
            yield _emit({"type": "progress", "msg": f"Train: {len(X_train)} | Test: {len(X_test)}"})

            # Build and train
            model_path = str(MODEL_DIR / f"{model_id}")
            metrics = {}
            feature_importance = {}

            if model_type == "lstm":
                yield _emit({"type": "progress", "msg": "Building LSTM model..."})
                # Reshape for LSTM: (samples, timesteps, features)
                def _reshape(X, lb):
                    out = []
                    for i in range(lb, len(X)):
                        out.append(X[i - lb:i])
                    return np.array(out)

                X_tr_seq = _reshape(X_train, lookback_steps)
                y_tr_seq = y_train[lookback_steps:]
                X_te_seq = _reshape(X_test, lookback_steps)
                y_te_seq = y_test[lookback_steps:]

                model = _build_lstm(len(valid_features), lookback_steps, task, hyperparams)
                epochs = hyperparams.get("epochs", 30)
                batch  = hyperparams.get("batch_size", 32)

                for epoch in range(1, epochs + 1):
                    history = model.fit(
                        X_tr_seq, y_tr_seq,
                        epochs=1, batch_size=batch, verbose=0
                    )
                    loss = history.history["loss"][0]
                    yield _emit({"type": "epoch", "epoch": epoch, "total": epochs, "loss": round(loss, 6)})

                # Evaluate
                eval_res = model.evaluate(X_te_seq, y_te_seq, verbose=0)
                if task == "classification":
                    y_pred = (model.predict(X_te_seq) > 0.5).astype(int).flatten()
                    from sklearn.metrics import accuracy_score, f1_score
                    metrics = {
                        "accuracy": round(accuracy_score(y_te_seq, y_pred), 4),
                        "f1": round(f1_score(y_te_seq, y_pred, average="weighted"), 4),
                        "loss": round(float(eval_res[0]), 6),
                    }
                else:
                    y_pred = model.predict(X_te_seq).flatten()
                    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
                    metrics = {
                        "rmse": round(float(np.sqrt(mean_squared_error(y_te_seq, y_pred))), 6),
                        "mae":  round(float(mean_absolute_error(y_te_seq, y_pred)), 6),
                        "r2":   round(float(r2_score(y_te_seq, y_pred)), 4),
                    }
                saved_path = model_path + ".keras"
                model.save(saved_path)

            else:
                # Sklearn-compatible
                yield _emit({"type": "progress", "msg": f"Training {model_type}..."})
                if model_type == "xgboost":
                    model = _build_xgboost(task, hyperparams)
                elif model_type == "lightgbm":
                    model = _build_lightgbm(task, hyperparams)
                else:
                    model = _build_sklearn(model_type, task, hyperparams)

                model.fit(X_train, y_train)
                yield _emit({"type": "progress", "msg": "Evaluating..."})

                y_pred = model.predict(X_test)
                if task == "classification":
                    from sklearn.metrics import (
                        accuracy_score, f1_score, confusion_matrix, classification_report
                    )
                    metrics = {
                        "accuracy": round(float(accuracy_score(y_test, y_pred)), 4),
                        "f1":       round(float(f1_score(y_test, y_pred, average="weighted")), 4),
                    }
                    try:
                        cm = confusion_matrix(y_test, y_pred)
                        labels = sorted(set(list(y_test)))
                        metrics["confusion_matrix"] = cm.tolist()
                        metrics["confusion_labels"] = [str(l) for l in labels]
                        report = classification_report(y_test, y_pred, output_dict=True)
                        for lbl in metrics["confusion_labels"]:
                            metrics[f"precision_{lbl}"] = round(report.get(str(lbl), {}).get("precision", 0.0), 4)
                            metrics[f"recall_{lbl}"]    = round(report.get(str(lbl), {}).get("recall",    0.0), 4)
                    except Exception:
                        pass
                else:
                    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
                    metrics = {
                        "rmse": round(float(np.sqrt(mean_squared_error(y_test, y_pred))), 6),
                        "mae":  round(float(mean_absolute_error(y_test, y_pred)), 6),
                        "r2":   round(float(r2_score(y_test, y_pred)), 4),
                    }

                # Feature importance
                if hasattr(model, "feature_importances_"):
                    feature_importance = {
                        f: round(float(imp), 6)
                        for f, imp in zip(valid_features, model.feature_importances_)
                    }
                elif hasattr(model, "coef_"):
                    coef = model.coef_.flatten() if model.coef_.ndim > 1 else model.coef_
                    feature_importance = {
                        f: round(float(c), 6)
                        for f, c in zip(valid_features, coef)
                    }

                saved_path = model_path + ".pkl"
                joblib.dump(model, saved_path)

            yield _emit({
                "type": "done",
                "model_id": model_id,
                "metrics": metrics,
                "feature_importance": feature_importance,
                "model_path": saved_path,
                "features_used": valid_features,
            })

        except Exception as e:
            yield _emit({"type": "error", "msg": str(e)})

    def predict(
        self,
        model_path: str,
        model_type: str,
        symbol: str,
        exchange: str,
        interval: str,
        features: list[str],
        task: str,
        horizon: int = 5,
        lookback_steps: int = 10,
    ) -> dict:
        """Run inference on the most recent data."""
        df = data_service.load_for_analysis(symbol, exchange, interval)
        if df is None or df.empty:
            return {"error": f"No data for {symbol}"}

        df = engineer_features(df)
        valid_features = [f for f in features if f in df.columns]
        df = df[valid_features].dropna()

        if model_type == "lstm":
            import tensorflow as tf
            model = tf.keras.models.load_model(model_path)
            last = df.values[-lookback_steps:]
            X = last.reshape(1, lookback_steps, len(valid_features))
            pred = float(model.predict(X, verbose=0)[0][0])
            preds = [{"candle": i + 1, "value": round(pred, 4)} for i in range(horizon)]
        else:
            model = joblib.load(model_path)
            last_row = df.values[-1].reshape(1, -1)
            if task == "classification":
                prob = model.predict_proba(last_row)[0]
                pred_class = int(model.predict(last_row)[0])
                confidence = round(float(max(prob)), 4)
                preds = [
                    {"candle": i + 1, "direction": "UP" if pred_class == 1 else "DOWN",
                     "confidence": confidence}
                    for i in range(horizon)
                ]
            else:
                pred = float(model.predict(last_row)[0])
                preds = [{"candle": i + 1, "value": round(pred, 4)} for i in range(horizon)]

        return {"symbol": symbol, "task": task, "predictions": preds}


ml_service = MLService()
