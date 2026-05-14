# Docker Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Containerise QuantDash with Docker Compose (6 services), replacing manual process management and fixing the ML event-loop blocking issue with Celery + Redis.

**Architecture:** Single `compose.yml` with postgres, redis, backend, celery-worker, frontend, nginx on a shared bridge network. Backend and celery-worker share the same Docker image. ML training dispatched as Celery tasks; frontend polls a new `/api/ml/tasks/{task_id}` endpoint instead of consuming an SSE stream.

**Tech Stack:** Docker Compose v2, python:3.11-slim, node:20-alpine (multi-stage), nginx:alpine, postgres:15, redis:7-alpine, Celery 5.x, celery[redis]

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| Create | `backend/vendor/.gitkeep` | marks vendor dir for git |
| Modify | `backend/requirements.txt` | fix wheel path, add celery+redis |
| Modify | `backend/config.py` | add REDIS_URL, DATA_DIR fields |
| Create | `backend/Dockerfile` | backend + celery-worker image |
| Create | `backend/.dockerignore` | exclude venv, logs, __pycache__ |
| Create | `backend/worker.py` | Celery app instance |
| Create | `backend/tasks/__init__.py` | package marker |
| Create | `backend/tasks/ml_tasks.py` | train_model_task Celery task |
| Modify | `backend/routers/ml.py` | replace train endpoint; add task status endpoint |
| Modify | `nginx.conf` | replace 127.0.0.1 with service names |
| Modify | `frontend/next.config.js` | add output:standalone; remove localhost rewrite |
| Create | `frontend/Dockerfile` | multi-stage Next.js image |
| Create | `frontend/.dockerignore` | exclude node_modules, .next |
| Create | `compose.yml` | all 6 services |
| Create | `.env.example` | template for .env |
| Modify | `frontend/app/ml/train/page.tsx` | replace SSE with polling |

---

## Task 1: One-Time File System Migration

**Files:**
- Create: `backend/vendor/.gitkeep`
- Create: `data/` directory
- Create: `.env`

- [ ] **Step 1: Create vendor directory and copy wheel**

```bash
cd /home/subaru/projects/python_dashboard
mkdir -p backend/vendor
cp /home/subaru/projects/FlatTrade_API-ReadyToUse/dist/norenrestapi-0.0.30-py3-none-any.whl backend/vendor/
touch backend/vendor/.gitkeep
```

- [ ] **Step 2: Create data directory (move existing CSVs if any)**

```bash
mkdir -p data
# If CSV data exists at the sibling path, move it:
# mv /home/subaru/projects/FlatTrade_API-ReadyToUse/data/* data/
```

- [ ] **Step 3: Create .env from current config**

```bash
cat > .env << 'EOF'
DATABASE_URL=postgresql+asyncpg://postgres:quantdash@postgres:5432/quantdash
SECRET_KEY=change_me_in_production
CORS_ORIGINS=["http://localhost","http://quantdash.saurav-info.xyz"]
DATA_DIR=/app/data
ML_MODELS_DIR=/app/ml_models
REDIS_URL=redis://redis:6379/0
FLATTRADE_PROJECT_PATH=/app
EOF
```

- [ ] **Step 4: Add .env to .gitignore**

Open `.gitignore` and ensure this line exists:
```
.env
```

- [ ] **Step 5: Commit**

```bash
git add backend/vendor/.gitkeep data/.gitkeep .gitignore
git commit -m "chore: add vendor dir, data dir, gitignore .env"
```

---

## Task 2: Fix requirements.txt — Wheel Path + Add Celery

**Files:**
- Modify: `backend/requirements.txt`

- [ ] **Step 1: Replace absolute wheel path with relative, add Celery**

In `backend/requirements.txt`, replace:
```
/home/subaru/projects/FlatTrade_API-ReadyToUse/dist/norenrestapi-0.0.30-py3-none-any.whl
```
With:
```
./vendor/norenrestapi-0.0.30-py3-none-any.whl
```

Then add after the `# FlatTrade API (bundled wheel)` section:
```
# Task queue
celery[redis]>=5.3.0
```

- [ ] **Step 2: Verify no other absolute paths remain**

```bash
grep -n "/home/subaru" backend/requirements.txt
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add backend/requirements.txt
git commit -m "fix: use relative wheel path in requirements, add celery"
```

---

## Task 3: Update config.py — Add REDIS_URL and DATA_DIR

**Files:**
- Modify: `backend/config.py`

- [ ] **Step 1: Add new fields to Settings**

Replace the contents of `backend/config.py` with:

```python
"""
config.py — Application Settings
Reads from .env file via pydantic-settings.
"""
import json
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    DATABASE_URL: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/flattrade_dashboard"
    )
    FLATTRADE_PROJECT_PATH: str = "/app"
    DATA_DIR: str = "./data"
    ML_MODELS_DIR: str = "./ml_models"
    REDIS_URL: str = "redis://localhost:6379/0"
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]
    SECRET_KEY: str = "change_me_in_production"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
```

- [ ] **Step 2: Commit**

```bash
git add backend/config.py
git commit -m "feat: add REDIS_URL and DATA_DIR to settings"
```

---

## Task 4: Backend .dockerignore and Dockerfile

**Files:**
- Create: `backend/.dockerignore`
- Create: `backend/Dockerfile`

- [ ] **Step 1: Create .dockerignore**

Create `backend/.dockerignore`:
```
venv/
__pycache__/
*.pyc
*.pyo
.env
logs/
*.log
ml_models/
.git/
```

- [ ] **Step 2: Create Dockerfile**

Create `backend/Dockerfile`:
```dockerfile
FROM python:3.11-slim

WORKDIR /app

# System dependencies for asyncpg, Playwright, LightGBM
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    wget \
    curl \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (layer cache)
COPY vendor/norenrestapi-0.0.30-py3-none-any.whl ./vendor/
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browser (Chromium for headless login)
RUN playwright install chromium

# Copy application code
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 3: Verify vendor wheel is present**

```bash
ls backend/vendor/
```
Expected: `norenrestapi-0.0.30-py3-none-any.whl  .gitkeep`

- [ ] **Step 4: Commit**

```bash
git add backend/.dockerignore backend/Dockerfile
git commit -m "feat: add backend Dockerfile and .dockerignore"
```

---

## Task 5: Update nginx.conf — Use Docker Service Names

**Files:**
- Modify: `nginx.conf`

The current config proxies to `127.0.0.1:8000` and `127.0.0.1:3000`. Inside Docker, these resolve via service names `backend` and `frontend`.

- [ ] **Step 1: Replace all 127.0.0.1 references with service names**

Replace `nginx.conf` with:
```nginx
##############################################################################
# QuantDash — Nginx Reverse Proxy Config
#
# Routes:
#   /          → Next.js  (port 3000)  — frontend
#   /api/      → FastAPI  (port 8000)  — REST
#   /api/live/ws/  → FastAPI (port 8000) — WebSocket (live market data)
##############################################################################

server {
    listen 80;
    server_name quantdash.saurav-info.xyz 204.168.154.171 _;

    proxy_read_timeout    600s;
    proxy_send_timeout    600s;
    proxy_connect_timeout  10s;

    proxy_set_header  X-Real-IP        $remote_addr;
    proxy_set_header  X-Forwarded-For  $proxy_add_x_forwarded_for;
    proxy_set_header  Host             $host;

    # WebSocket: Live market data (/api/live/ws/*)
    location /api/live/ws/ {
        proxy_pass         http://backend:8000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
    }

    # FastAPI REST (/api/*)
    location /api/ {
        proxy_pass         http://backend:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host             $host;
        proxy_set_header   X-Real-IP        $remote_addr;
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 600s;
    }

    # Next.js frontend (everything else)
    location / {
        proxy_pass         http://frontend:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_buffering    off;
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add nginx.conf
git commit -m "fix: nginx proxy targets use Docker service names"
```

---

## Task 6: Update next.config.js — Standalone Output

**Files:**
- Modify: `frontend/next.config.js`

- [ ] **Step 1: Add output:standalone, remove localhost rewrite**

Replace `frontend/next.config.js` with:
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  swcMinify: true,
  compress: true,
}

module.exports = nextConfig
```

The `rewrites` block that proxied `/api/*` to `localhost:8000` is removed — nginx handles all routing in Docker. Client-side `fetch('/api/...')` calls hit nginx which proxies to the backend container.

- [ ] **Step 2: Commit**

```bash
git add frontend/next.config.js
git commit -m "feat: add Next.js standalone output for Docker build"
```

---

## Task 7: Frontend .dockerignore and Dockerfile

**Files:**
- Create: `frontend/.dockerignore`
- Create: `frontend/Dockerfile`

- [ ] **Step 1: Create .dockerignore**

Create `frontend/.dockerignore`:
```
node_modules/
.next/
.env
*.log
```

- [ ] **Step 2: Create multi-stage Dockerfile**

Create `frontend/Dockerfile`:
```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Run
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output includes all required files
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
```

- [ ] **Step 3: Commit**

```bash
git add frontend/.dockerignore frontend/Dockerfile
git commit -m "feat: add frontend multi-stage Dockerfile"
```

---

## Task 8: compose.yml

**Files:**
- Create: `compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Create compose.yml**

Create `compose.yml` at the project root:
```yaml
services:

  postgres:
    image: postgres:15
    restart: always
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: quantdash
      POSTGRES_DB: quantdash
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - quantdash-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: always
    networks:
      - quantdash-net
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    restart: always
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./backend/ml_models:/app/ml_models
    networks:
      - quantdash-net
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  celery-worker:
    build:
      context: ./backend
      dockerfile: Dockerfile
    restart: always
    command: celery -A worker worker --loglevel=info --concurrency=2
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./backend/ml_models:/app/ml_models
    networks:
      - quantdash-net
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    restart: always
    networks:
      - quantdash-net
    depends_on:
      - backend

  nginx:
    image: nginx:alpine
    restart: always
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - quantdash-net
    depends_on:
      - backend
      - frontend

volumes:
  postgres-data:

networks:
  quantdash-net:
    driver: bridge
```

- [ ] **Step 2: Create .env.example**

Create `.env.example`:
```env
# Database — host must be "postgres" (Docker service name)
DATABASE_URL=postgresql+asyncpg://postgres:quantdash@postgres:5432/quantdash

# Change this in production
SECRET_KEY=change_me_in_production

# CORS — comma-separated or JSON array
CORS_ORIGINS=["http://localhost","http://your-domain.com"]

# Container-internal paths (do not change unless you update compose.yml)
DATA_DIR=/app/data
ML_MODELS_DIR=/app/ml_models

# FlatTrade project path inside container
FLATTRADE_PROJECT_PATH=/app

# Redis / Celery
REDIS_URL=redis://redis:6379/0
```

- [ ] **Step 3: Commit**

```bash
git add compose.yml .env.example
git commit -m "feat: add docker-compose with 6 services"
```

---

## Task 9: Celery App — worker.py

**Files:**
- Create: `backend/worker.py`

- [ ] **Step 1: Create Celery app instance**

Create `backend/worker.py`:
```python
"""
worker.py — Celery application instance.

Import this module to get the configured Celery app.
The celery-worker container runs:
    celery -A worker worker --loglevel=info
"""
from celery import Celery
from config import settings

celery_app = Celery(
    "quantdash",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["tasks.ml_tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=3600,  # task results expire after 1h
)
```

- [ ] **Step 2: Commit**

```bash
git add backend/worker.py
git commit -m "feat: add Celery app instance in worker.py"
```

---

## Task 10: Celery Task — tasks/ml_tasks.py

**Files:**
- Create: `backend/tasks/__init__.py`
- Create: `backend/tasks/ml_tasks.py`

- [ ] **Step 1: Create package marker**

```bash
touch backend/tasks/__init__.py
```

- [ ] **Step 2: Create ml_tasks.py**

Create `backend/tasks/ml_tasks.py`:
```python
"""
tasks/ml_tasks.py — Celery task for ML model training.

Wraps ml_service.train_stream() so training runs in the
celery-worker container instead of blocking the FastAPI event loop.
"""
import json as _json
from worker import celery_app
from services.ml_service import ml_service


@celery_app.task(bind=True)
def train_model_task(self, model_id: str, name: str, train_params: dict):
    """
    Run ML training in the background.

    Args:
        model_id: UUID string pre-generated by the router.
        name: Human-readable model name supplied by the user.
        train_params: Dict matching ml_service.train_stream() kwargs
                      (symbol, exchange, interval, features, model_type,
                       task, split_ratio, hyperparams, filters, lookback_steps).

    Returns:
        Dict with keys: model_id, name, metrics, feature_importance,
                        model_path, features_used, symbol, exchange,
                        model_type, task, hyperparams, filters, interval,
                        date_from, date_to.

    Raises:
        Exception: propagated from training errors so Celery marks task FAILURE.
    """
    gen = ml_service.train_stream(model_id=model_id, **train_params)

    for sse_str in gen:
        raw = sse_str.strip()
        if not raw.startswith("data: "):
            continue
        try:
            event = _json.loads(raw[6:])
        except _json.JSONDecodeError:
            continue

        etype = event.get("type")

        if etype in ("start", "progress"):
            self.update_state(state="PROGRESS", meta={"msg": event.get("msg", ""), "type": etype})

        elif etype == "epoch":
            self.update_state(state="PROGRESS", meta={
                "type": "epoch",
                "epoch": event.get("epoch"),
                "total": event.get("total"),
                "loss": event.get("loss"),
            })

        elif etype == "done":
            return {
                "model_id": model_id,
                "name": name,
                "symbol": train_params["symbol"],
                "exchange": train_params["exchange"],
                "model_type": train_params["model_type"],
                "task": train_params["task"],
                "hyperparams": train_params["hyperparams"],
                "filters": train_params["filters"],
                "interval": train_params["interval"],
                "date_from": train_params.get("date_from"),
                "date_to": train_params.get("date_to"),
                "features_used": event.get("features_used", []),
                "metrics": event.get("metrics", {}),
                "feature_importance": event.get("feature_importance", {}),
                "model_path": event.get("model_path"),
            }

        elif etype == "error":
            raise Exception(event.get("msg", "Training failed"))

    raise Exception("train_stream ended without a 'done' event")
```

- [ ] **Step 3: Commit**

```bash
git add backend/tasks/__init__.py backend/tasks/ml_tasks.py
git commit -m "feat: Celery task wrapping ml_service.train_stream"
```

---

## Task 11: Update routers/ml.py — Replace Train Endpoint

**Files:**
- Modify: `backend/routers/ml.py`

Replace only the `train_model` endpoint and `_async_train` helper. All other endpoints (`list_models`, `get_model`, `predict`, `backtest`, `delete_model`) remain unchanged.

- [ ] **Step 1: Replace imports at top of routers/ml.py**

The file currently imports `StreamingResponse`. Remove that import and add Celery imports.

Replace the imports block (lines 1-17) with:
```python
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
```

- [ ] **Step 2: Replace train_model endpoint and remove _async_train**

Replace the `train_model` function and `_async_train` helper (lines 28-96) with:

```python
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
```

- [ ] **Step 3: Verify the rest of the file is intact**

```bash
grep -n "def " backend/routers/ml.py
```
Expected output (all endpoints present):
```
def list_features
def train_model
def get_task_status
def list_models
def get_model
def predict
def get_recent_prices
def backtest_model
def delete_model
```

- [ ] **Step 4: Commit**

```bash
git add backend/routers/ml.py
git commit -m "feat: replace SSE train endpoint with Celery task dispatch + task status endpoint"
```

---

## Task 12: Update Frontend Train Page — Replace SSE with Polling

**Files:**
- Modify: `frontend/app/ml/train/page.tsx`

The `handleTrain` function currently uses `fetch` + SSE stream reading. Replace it with a `POST` to get `task_id`, then `setInterval` polling against `/api/ml/tasks/{task_id}`.

- [ ] **Step 1: Add train and getTaskStatus to mlApi in api.ts**

Open `frontend/lib/api.ts`. Find the `mlApi` object (around line 91). Add two new methods after `buildTrainPayload`:

```typescript
  train: (payload: object) =>
    api.post('/ml/train', payload),
  getTaskStatus: (taskId: string) =>
    api.get(`/ml/tasks/${taskId}`),
```

The `train` method posts to the new dispatch endpoint (returns `{task_id, model_id}` immediately). The `getTaskStatus` method polls for progress.

- [ ] **Step 2: Replace handleTrain in page.tsx**

In `frontend/app/ml/train/page.tsx`, find `const handleTrain = () => {` (line ~94) and replace the entire function with:

```typescript
const handleTrain = () => {
  if (!symbol || !features.length) return
  setTraining(true); setLogs([]); setMetrics(null); setModelId(null); setLossHistory([])
  addLog(`Starting ${MODEL_TYPES.find(m => m.id === modelType)?.label} training for ${symbol}`, 'info')
  addLog(`Features: ${features.join(', ')}`, 'info')

  const payload = mlApi.buildTrainPayload({
    symbol,
    modelType,
    features,
    targetHorizon,
    interval,
    testSplit,
    hyperparams: modelType === 'lstm'
      ? { lstm_layers: lstmLayers, units: lstmUnits, epochs: lstmEpochs, lookback_steps: lstmSeqLen }
      : { n_estimators: nEstimators, max_depth: maxDepth },
  })

  mlApi.train(payload)
    .then(res => {
      const { task_id, model_id } = res.data
      addLog(`Task dispatched. Model ID: ${model_id}`, 'info')

      const pollInterval = setInterval(() => {
        mlApi.getTaskStatus(task_id)
          .then(r => {
            const d = r.data
            switch (d.state) {
              case 'PENDING':
                addLog('Waiting for worker...', 'info')
                break
              case 'PROGRESS':
                if (d.type === 'epoch') {
                  addLog(`Epoch ${d.epoch}/${d.total}: loss=${d.loss?.toFixed(4)}`, 'info')
                  setLossHistory(prev => [...prev, { epoch: d.epoch, loss: d.loss }])
                } else {
                  addLog(d.msg || 'Training...', 'info')
                }
                break
              case 'SUCCESS':
                clearInterval(pollInterval)
                setMetrics(d.metrics)
                setModelId(d.model_id)
                addLog(`Training complete! Model saved as ${d.model_id}`, 'ok')
                setTraining(false)
                break
              case 'FAILURE':
                clearInterval(pollInterval)
                addLog(`Training failed: ${d.msg}`, 'err')
                setTraining(false)
                break
            }
          })
          .catch(err => {
            clearInterval(pollInterval)
            addLog(`Poll error: ${err.message}`, 'err')
            setTraining(false)
          })
      }, 1000)
    })
    .catch(err => {
      addLog(`Failed to start training: ${err.message}`, 'err')
      setTraining(false)
    })
}
```

- [ ] **Step 3: Remove the AbortController ref (no longer needed)**

Find and remove the line `const controller = new AbortController()` if it exists outside `handleTrain`.

- [ ] **Step 4: Verify new methods exist in api.ts**

```bash
grep -n "train\|getTaskStatus" frontend/lib/api.ts
```
Expected: lines for both `train:` and `getTaskStatus:` in the `mlApi` object.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/ml/train/page.tsx frontend/lib/api.ts
git commit -m "feat: replace SSE train progress with Celery task polling"
```

---

## Task 13: Build and Verify

- [ ] **Step 1: Build all images**

```bash
cd /home/subaru/projects/python_dashboard
docker compose build
```
Expected: all 3 builds (backend, frontend — postgres/redis/nginx use official images) succeed with no errors.

- [ ] **Step 2: Start services**

```bash
docker compose up -d
```
Expected: 6 containers start. Check with:
```bash
docker compose ps
```
All 6 services should show `running` or `healthy`.

- [ ] **Step 3: Check backend health**

```bash
docker compose logs backend --tail=20
```
Expected: `Application startup complete.` — no import errors or connection failures.

- [ ] **Step 4: Check celery-worker health**

```bash
docker compose logs celery-worker --tail=20
```
Expected: `celery@... ready.` — worker connected to Redis.

- [ ] **Step 5: Check frontend build**

```bash
docker compose logs frontend --tail=10
```
Expected: starts listening on port 3000.

- [ ] **Step 6: Smoke test via nginx**

```bash
curl -s http://localhost/api/ml/features | head -c 100
```
Expected: JSON array of feature names.

- [ ] **Step 7: Run DB migrations if needed**

```bash
docker compose exec backend alembic upgrade head
```

- [ ] **Step 8: Final commit**

```bash
git add .
git commit -m "chore: docker compose setup complete"
```
