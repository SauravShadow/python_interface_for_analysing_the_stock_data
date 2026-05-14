# Docker Setup Design — QuantDash

**Date:** 2026-05-13  
**Status:** Approved

## Overview

Containerise the QuantDash application using Docker Compose (single file, Approach A) with six services. Adds a Celery + Redis ML worker to fix the event loop blocking issue. Uses bind mounts for CSV data and ML models so files remain directly accessible on the host.

---

## Service Architecture

Six services on a shared bridge network `quantdash-net`:

```
                    ┌─────────────────────────────────┐
                    │           nginx :80              │
                    └────────┬──────────┬─────────────┘
                             │          │
                     /api/*  │          │  /*
                             ▼          ▼
                 ┌──────────────┐  ┌──────────┐
                 │  backend     │  │ frontend │
                 │  :8000       │  │ :3000    │
                 └──────┬───┬──┘  └──────────┘
                        │   │
           task queue   │   │ read/predict
                        ▼   ▼
                ┌──────────────┐     ┌──────────────┐
                │    redis     │     │   postgres   │
                │    :6379     │     │   :5432      │
                └──────┬───────┘     └──────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  celery-worker   │
              │  (same image as  │
              │   backend)       │
              └──────────────────┘
```

| Service | Image | Notes |
|---|---|---|
| `postgres` | `postgres:15` | Official image, no custom Dockerfile |
| `redis` | `redis:7-alpine` | Official image, no custom Dockerfile |
| `backend` | Built from `backend/Dockerfile` | FastAPI + Playwright |
| `celery-worker` | Same image as `backend` | Different `command` only |
| `frontend` | Built from `frontend/Dockerfile` | Next.js 14 multi-stage |
| `nginx` | `nginx:alpine` | Volume-mounts existing `nginx.conf` |

All services use `restart: always`.

---

## Dockerfiles

### Backend (`backend/Dockerfile`)

Single-stage, `python:3.11-slim` base.

```
1. Install system deps: gcc, libpq-dev, wget
2. COPY vendor/norenrestapi-0.0.30-py3-none-any.whl ./
3. COPY requirements.txt ./
4. RUN pip install -r requirements.txt ./norenrestapi-*.whl
5. RUN playwright install chromium --with-deps
6. COPY . .
7. CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- `backend/vendor/norenrestapi-0.0.30-py3-none-any.whl` — copy in from current location at `/home/subaru/projects/FlatTrade_API-ReadyToUse/dist/` as a one-time step.
- `celery-worker` uses the same image with `command: celery -A worker worker --loglevel=info`.

### Frontend (`frontend/Dockerfile`)

Multi-stage, `node:20-alpine`.

```
Stage 1 — builder:
  npm ci → npm run build

Stage 2 — runner:
  Copy .next/standalone, .next/static, public
  CMD ["node", "server.js"]
```

Keeps final image ~200MB by discarding node_modules and build tooling.

**Required config change:** `frontend/next.config.js` must include `output: 'standalone'`. Without this, Next.js does not emit the `standalone` directory and Stage 2 of the Dockerfile will fail at build time.

---

## Data & Volumes

| Mount | Type | Host path | Container path | Services |
|---|---|---|---|---|
| PostgreSQL data | Named volume | `postgres-data` | `/var/lib/postgresql/data` | `postgres` |
| CSV data files | Bind mount | `./data/` | `/app/data/` | `backend`, `celery-worker` |
| ML model files | Bind mount | `./backend/ml_models/` | `/app/ml_models/` | `backend`, `celery-worker` |
| Nginx config | Bind mount | `./nginx.conf` | `/etc/nginx/conf.d/default.conf` | `nginx` |

**One-time migration:** Move existing CSVs from `/home/subaru/projects/FlatTrade_API-ReadyToUse/data/` to `./data/` inside the project before first run.

---

## Celery Integration

Moves ML training off the FastAPI event loop into a background worker.

### New files

- **`backend/worker.py`** — Celery app instance:
  ```python
  celery = Celery("quantdash", broker=settings.REDIS_URL, backend=settings.REDIS_URL)
  ```

- **`backend/tasks/ml_tasks.py`** — Training as a Celery task:
  ```python
  @celery.task(bind=True)
  def train_model_task(self, params):
      # wraps existing MLService.train() logic
      # reports progress via self.update_state()
  ```

### Modified files

- **`routers/ml.py`** train endpoint — dispatches task, returns `task_id`:
  ```python
  task = train_model_task.delay(params)
  return {"task_id": task.id}
  ```

- **New endpoint** `GET /api/ml/tasks/{task_id}` — returns task state + progress from Redis.

- **`frontend/app/ml/train/`** — replaces SSE listener with 1s polling against the task status endpoint.

### What stays the same

Core `MLService.train()` logic is untouched — only wrapped in a Celery task.

---

## Environment & Config

Single `.env` at project root, passed to containers via `env_file` in compose.

```env
# Database (host changes from localhost → postgres service name)
DATABASE_URL=postgresql+asyncpg://postgres:password@postgres:5432/quantdash

# Auth
SECRET_KEY=your-secret-key

# CORS
CORS_ORIGINS=http://localhost,http://quantdash.saurav-info.xyz

# Paths (container-internal)
DATA_DIR=/app/data
ML_MODELS_DIR=/app/ml_models

# Celery / Redis (new)
REDIS_URL=redis://redis:6379/0
```

**Breaking change from current config:** `DATABASE_URL` host must change from `localhost` to `postgres`.

`backend/worker.py` reads `REDIS_URL` from env so the Celery app works identically inside and outside Docker.

---

## One-Time Migration Steps

Before first `docker compose up`:

1. Copy FlatTrade wheel into project:
   ```
   mkdir -p python_dashboard/backend/vendor
   cp /home/subaru/projects/FlatTrade_API-ReadyToUse/dist/norenrestapi-0.0.30-py3-none-any.whl \
      python_dashboard/backend/vendor/
   ```
2. Move CSV data into project:
   ```
   mv /home/subaru/projects/FlatTrade_API-ReadyToUse/data/ \
      python_dashboard/data/
   ```
3. Update `.env` with new `DATABASE_URL` host and new vars.

---

## Out of Scope

- API authentication (separate concern, existing HLD recommendation)
- Session token encryption (separate concern)
- CI/CD pipeline
- Multi-host / swarm deployment
