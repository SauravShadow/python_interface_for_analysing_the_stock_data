# QuantDash — Stock Market Intelligence Dashboard

A full-stack personal trading dashboard for Indian equity markets (NSE/BSE). Connects to the [FlatTrade](https://flattrade.in) broker API to stream live ticks, download historical OHLCV data, run technical analysis, train ML prediction models, and visualise everything in a Next.js frontend.

**Live at:** `quantdash.saurav-info.xyz`

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Data Flows](#data-flows)
  - [Authentication & Token Lifecycle](#authentication--token-lifecycle)
  - [Historical Data Download](#historical-data-download)
  - [Live Tick Streaming](#live-tick-streaming)
  - [Technical Analysis](#technical-analysis)
  - [ML Model Training & Inference](#ml-model-training--inference)
- [Directory Structure](#directory-structure)
- [API Reference](#api-reference)
- [Setup & Installation](#setup--installation)
- [Environment Variables](#environment-variables)

---

## Features

| Feature | Description |
|---------|-------------|
| **Live Quotes** | Real-time tick streaming via WebSocket (FlatTrade) |
| **Price Alerts** | Above/below price threshold notifications |
| **Historical Data** | Incremental OHLCV download with SSE progress |
| **Technical Analysis** | 10 analysis types: price, technicals, volatility, ML, and more |
| **Multi-stock Comparison** | Normalised prices, correlation matrix, beta analysis |
| **ML Models** | Train RF, XGBoost, LightGBM, LSTM with 35+ engineered features |
| **Backtesting** | Replay trained models on historical candles with equity curve |
| **OTP Login** | Headless Playwright browser handles FlatTrade 2FA automatically |

---

## Tech Stack

### Backend
| Component | Technology |
|-----------|-----------|
| Framework | FastAPI 0.109 + Uvicorn |
| Database | PostgreSQL 15 + TimescaleDB |
| ORM | SQLAlchemy 2.0 (async) |
| Task Queue | Celery 5.3 + Redis 7 |
| ML | scikit-learn, XGBoost, LightGBM, TensorFlow/Keras |
| Data | Pandas, NumPy, SciPy, `ta` (technical analysis) |
| Broker API | NorenApiPy (FlatTrade) + Playwright (headless login) |

### Frontend
| Component | Technology |
|-----------|-----------|
| Framework | Next.js 14.2 (App Router) |
| Language | TypeScript 5.5 |
| Charts | Recharts 2.12 |
| State | Zustand 4.5 |
| HTTP | Axios 1.7 |
| Icons | Lucide React |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| Reverse Proxy | Nginx (Alpine) |
| Containerisation | Docker Compose |
| Database | TimescaleDB hypertable (time-series compression) |

---

## Architecture

```mermaid
graph TB
    subgraph Client["Browser (Next.js)"]
        UI[Pages / Components]
        Store[Zustand Auth Store]
        API_LIB[Axios API Client]
        WS_CLIENT[WebSocket Client]
    end

    subgraph Nginx["Nginx Reverse Proxy"]
        PROXY[quantdash.saurav-info.xyz]
    end

    subgraph Backend["FastAPI Backend :8000"]
        AUTH_R[/api/auth]
        STOCK_R[/api/stocks]
        DATA_R[/api/data]
        ANALYSIS_R[/api/analysis]
        ML_R[/api/ml]
        LIVE_R[/api/live/ws]

        FT_SVC[FlattradeService]
        LIVE_SVC[LiveService]
        DATA_SVC[DataService]
        ANALYSIS_SVC[AnalysisService]
        ML_SVC[MLService]
    end

    subgraph Workers["Celery Worker"]
        TRAIN_TASK[train_model_task]
    end

    subgraph Storage["Storage"]
        TSDB[(TimescaleDB\nOHLCV hypertable)]
        PG[(PostgreSQL\nwatchlist / ml_models / analyses)]
        DISK[Disk\n.pkl / .keras models]
        TOKEN[.session_token]
        REDIS[(Redis\nCelery broker)]
    end

    subgraph Broker["FlatTrade Broker"]
        FT_REST[REST API\nquotes / historical]
        FT_WS[WebSocket\nlive ticks]
        FT_WEB[Web Portal\nOTP login]
    end

    UI --> API_LIB
    UI --> WS_CLIENT
    API_LIB -- HTTP --> PROXY
    WS_CLIENT -- WS --> PROXY
    PROXY -- /api/live/ws --> LIVE_R
    PROXY -- /api/* --> AUTH_R & STOCK_R & DATA_R & ANALYSIS_R & ML_R

    AUTH_R --> FT_SVC
    STOCK_R --> FT_SVC
    DATA_R --> DATA_SVC
    ANALYSIS_R --> ANALYSIS_SVC
    ML_R --> ML_SVC
    LIVE_R --> LIVE_SVC

    FT_SVC --> FT_REST
    FT_SVC --> FT_WEB
    LIVE_SVC --> FT_WS

    DATA_SVC --> TSDB
    ML_SVC --> DISK
    ML_SVC --> DATA_SVC
    ANALYSIS_SVC --> DATA_SVC
    FT_SVC --> TOKEN

    ML_R -- dispatch --> REDIS
    REDIS --> TRAIN_TASK
    TRAIN_TASK --> ML_SVC
    TRAIN_TASK --> PG

    STOCK_R --> PG
    ML_R --> PG
    ANALYSIS_R --> PG
```

---

## Data Flows

### Authentication & Token Lifecycle

FlatTrade uses a daily OTP flow. Playwright automates the headless login so the user only needs to paste the OTP.

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant BE as FastAPI
    participant PW as Playwright (thread)
    participant FT as FlatTrade Web

    User->>FE: Enter password + PAN/DOB
    FE->>BE: POST /api/auth/start-login
    BE->>PW: Spawn headless browser thread
    PW->>FT: Navigate & fill credentials
    FT-->>PW: Prompt for OTP
    Note over PW: Monkey-patches builtins.input<br/>Thread blocks waiting for OTP

    loop Poll every 1.5s
        FE->>BE: GET /api/auth/status
        BE-->>FE: { status: "waiting_otp" }
    end

    FE->>User: Show OTP input form
    User->>FE: Enter OTP
    FE->>BE: POST /api/auth/submit-otp
    BE->>PW: Put OTP in queue (unblocks thread)
    PW->>FT: Submit OTP
    FT-->>PW: Login success + session token
    PW->>BE: Save token to .session_token

    BE-->>FE: { status: "done", client_id, token_hours_remaining }
    FE->>User: Redirect to dashboard
```

**Token lifecycle:**

```mermaid
graph LR
    A[Market Open\n9:15 AM IST] -->|Valid token| B[All features active]
    B --> C[Market Close\n3:30 PM IST]
    C --> D[Token expires\n5:00 AM IST next day]
    D -->|Background task| E{Token valid?}
    E -->|Yes| F[Log refresh OK]
    E -->|No| G[Warn: re-login required]
    G -->|User logs in| B
```

---

### Historical Data Download

Data is fetched in day-sized chunks and stored in a TimescaleDB hypertable. Downloads are incremental — already-downloaded ranges are skipped.

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant BE as FastAPI (SSE)
    participant DS as DataService
    participant FT as FlatTrade API
    participant DB as TimescaleDB

    User->>FE: Select stocks, days, chunk size
    FE->>BE: POST /api/data/download
    Note over BE,FE: Response is a Server-Sent Events stream

    loop For each stock
        DS->>DB: Check existing date range
        loop For each day chunk
            DS->>FT: get_time_price_series(exchange, token, from, to)
            FT-->>DS: OHLCV rows
            DS->>DB: Upsert rows (dedup by datetime+symbol)
            DS-->>FE: SSE: { type:"progress", stock, downloaded_days, total_days }
        end
    end

    DS-->>FE: SSE: { type:"complete" }
    FE->>User: Show "Downloaded ✓"
```

---

### Live Tick Streaming

A single FlatTrade WebSocket connection is multiplexed across all connected browser clients.

```mermaid
graph TD
    subgraph Browsers["Browser Clients"]
        C1[Client A\nSBIN + INFY]
        C2[Client B\nSBIN]
        C3[Client C\nRELIANCE]
    end

    subgraph WS_HUB["LiveService (WebSocket Hub)"]
        REG[Token → Client Registry]
        ALERT[Alert Checker]
        BROADCAST[Async Broadcaster\nrun_coroutine_threadsafe]
    end

    subgraph FT["FlatTrade"]
        FT_WS[WebSocket\nlive tick stream]
    end

    C1 -- WS /api/live/ws/multiplex\nsubscribe SBIN, INFY --> REG
    C2 -- WS /api/live/ws/multiplex\nsubscribe SBIN --> REG
    C3 -- WS /api/live/ws/multiplex\nsubscribe RELIANCE --> REG

    FT_WS -- tick: SBIN ltp=450.50 --> ALERT
    ALERT -- check configured alerts --> BROADCAST
    BROADCAST -- push tick JSON --> C1
    BROADCAST -- push tick JSON --> C2

    REG -- first SBIN sub → subscribe NSE|3045 --> FT_WS
    REG -- first RELIANCE sub → subscribe NSE|2885 --> FT_WS
```

---

### Technical Analysis

```mermaid
flowchart TD
    A[User selects symbol\n+ analysis types\n+ filters] --> B[POST /api/analysis/run]

    B --> C{mode?}

    C -- single --> D[Load OHLCV from TimescaleDB]
    D --> E[Resample to requested interval]
    E --> F[Run selected analysis types]

    F --> F1[price: OHLC stats, levels]
    F --> F2[technicals: SMA/EMA/MACD/RSI/BB/ATR]
    F --> F3[volatility: rolling vol, Parkinson]
    F --> F4[volume: OBV, volume profile]
    F --> F5[patterns: hour/day-of-week heatmap]
    F --> F6[drawdown: max DD, duration]
    F --> F7[seasonality: monthly/weekly patterns]
    F --> F8[momentum: ROC, divergence]
    F --> F9[riskreturn: Sharpe, Sortino, VaR]

    C -- compare --> G[Load OHLCV for each symbol]
    G --> H[Normalise prices to base 100]
    H --> I[Compute correlation matrix]
    I --> J[Compute beta vs first symbol]

    F1 & F2 & F3 & F4 & F5 & F6 & F7 & F8 & F9 --> K[Recharts-ready JSON]
    J --> K

    K --> L[Frontend renders charts]
    L --> M{Save?}
    M -- yes --> N[POST /api/analysis/save\n→ PostgreSQL]
```

---

### ML Model Training & Inference

ML training is offloaded to a Celery worker to avoid blocking the FastAPI event loop.

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant BE as FastAPI
    participant REDIS as Redis
    participant CW as Celery Worker
    participant DB as PostgreSQL
    participant DISK as Disk (.pkl/.keras)

    User->>FE: Select symbol, model type,\nfeatures, hyperparams
    FE->>BE: POST /api/ml/train
    BE->>REDIS: Dispatch train_model_task (task_id)
    BE-->>FE: { task_id, model_id }

    loop Poll every 2s
        FE->>BE: GET /api/ml/tasks/{task_id}
        BE->>REDIS: Check task state
        REDIS-->>BE: PENDING → PROGRESS → SUCCESS
        BE-->>FE: { state, epoch, loss } (LSTM streams epochs)
    end

    Note over CW: Runs in separate process
    CW->>CW: Load OHLCV from TimescaleDB
    CW->>CW: Engineer 35+ features
    CW->>CW: Train/test split → fit model
    CW->>CW: Compute metrics (RMSE/R²/Accuracy/F1)
    CW->>DISK: Save model (.pkl or .keras)
    CW->>DB: Save metadata to ml_models table

    FE->>User: Display metrics + feature importance
```

**Supported models and features:**

```mermaid
mindmap
  root((ML Engine))
    Models
      Random Forest
      XGBoost
      LightGBM
      LSTM
      Linear Regression
      Ridge / Lasso
      SVM
    Tasks
      Regression\nprice prediction
      Classification\nUP / DOWN signal
    Features
      Price
        returns, log_returns
        range_pct, body_pct, wick_ratio
      Moving Averages
        SMA 5 / 10 / 20
        EMA 9 / 21
      Momentum
        RSI 14, MACD
        Stochastic K/D
      Volatility
        ATR 14, BB width
        Rolling std
      Volume
        volume_change, vs_20d_avg
        OBV
      Time
        hour, day_of_week
        month_start / month_end
      Lags
        close_lag 1-3
        returns_lag 1-2
```

---

## Directory Structure

```
python_dashboard/
├── backend/
│   ├── main.py                  # FastAPI app, lifespan, CORS, routers
│   ├── config.py                # Pydantic settings (env vars)
│   ├── database.py              # SQLAlchemy async engine
│   ├── logger.py                # Logging configuration
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── models/                  # SQLAlchemy ORM models
│   │   ├── ohlcv.py             # TimescaleDB hypertable
│   │   ├── watchlist.py
│   │   ├── ml_model.py
│   │   └── analysis.py
│   ├── schemas/                 # Pydantic request/response schemas
│   │   ├── auth.py
│   │   ├── stocks.py
│   │   ├── data.py
│   │   ├── analysis.py
│   │   ├── ml.py
│   │   └── live.py
│   ├── routers/                 # FastAPI route handlers
│   │   ├── auth.py              # POST /api/auth/*
│   │   ├── stocks.py            # GET/POST /api/stocks/*
│   │   ├── data.py              # POST/GET /api/data/* (SSE)
│   │   ├── analysis.py          # POST/GET /api/analysis/*
│   │   ├── ml.py                # POST/GET /api/ml/*
│   │   └── live.py              # WS /api/live/ws/*, REST /api/live/*
│   ├── services/                # Business logic
│   │   ├── flattrade.py         # Broker API bridge + headless login
│   │   ├── live_service.py      # WebSocket multiplex hub
│   │   ├── data_service.py      # OHLCV download + TimescaleDB storage
│   │   ├── analysis_service.py  # Technical analysis engine
│   │   ├── ml_service.py        # ML training + inference
│   │   └── ohlcv_store.py       # Storage abstraction
│   └── vendor/
│       └── norenrestapi-0.0.30-py3-none-any.whl
├── frontend/
│   ├── app/
│   │   ├── layout.tsx           # Root layout + Sidebar
│   │   ├── page.tsx             # Dashboard homepage
│   │   ├── login/page.tsx       # FlatTrade OTP login
│   │   ├── stocks/page.tsx      # Search & watchlist
│   │   ├── data/page.tsx        # Historical download (SSE)
│   │   ├── analysis/page.tsx    # Single-stock analysis
│   │   ├── analysis/compare/page.tsx
│   │   ├── ml/train/page.tsx    # Model training UI
│   │   ├── ml/models/page.tsx   # Models list, predict, backtest
│   │   ├── live/page.tsx        # Real-time quotes + charts
│   │   └── live/alerts/page.tsx
│   ├── components/
│   │   └── Sidebar.tsx
│   ├── lib/
│   │   ├── api.ts               # Axios client + all endpoint helpers
│   │   ├── store.ts             # Zustand auth store
│   │   └── logger.ts
│   ├── package.json
│   └── Dockerfile               # Multi-stage build
├── docs/                        # Architecture docs & specs
├── data/                        # Downloaded OHLCV (gitignored)
├── HLD.md                       # High Level Design document
├── docker-compose.yml
└── nginx.conf
```

---

## API Reference

### Auth — `/api/auth`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/start-login` | Start headless Playwright login |
| POST | `/submit-otp` | Send OTP to unblock login thread |
| GET | `/status` | Poll login state + token info |
| POST | `/logout` | Invalidate session |

### Stocks — `/api/stocks`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/search?q=SBIN&exchange=NSE` | Search for a stock |
| GET | `/watchlist` | List saved stocks |
| POST | `/watchlist` | Add stock to watchlist |
| DELETE | `/watchlist/{tsym}` | Remove from watchlist |

### Data — `/api/data`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/summary` | Symbols downloaded + record counts |
| POST | `/download` | Start SSE download stream |
| POST | `/resample` | Resample to a different interval |
| DELETE | `/{symbol}` | Delete all records for symbol |

### Analysis — `/api/analysis`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/run` | Run analysis (returns Recharts JSON) |
| GET | `/saved` | List saved analyses |
| GET | `/saved/{id}` | Load saved analysis |
| POST | `/save` | Persist analysis to DB |
| DELETE | `/saved/{id}` | Delete analysis |

### ML — `/api/ml`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/features` | List available feature names |
| POST | `/train` | Dispatch training to Celery |
| GET | `/tasks/{task_id}` | Poll Celery task status |
| GET | `/models` | List trained models |
| GET | `/models/{id}` | Model metadata + metrics |
| POST | `/predict` | Run inference |
| GET | `/backtest/{id}` | Replay model on historical data |
| DELETE | `/models/{id}` | Delete model |

### Live — `/api/live`

| Method | Path | Description |
|--------|------|-------------|
| WS | `/ws/multiplex` | Multi-symbol WebSocket stream |
| GET | `/quote/{exchange}/{token}` | Single REST quote |
| GET | `/quotes?tokens=…` | Batch quotes |
| GET | `/intraday/{exchange}/{token}` | Today's intraday candles |
| POST | `/alerts` | Set price alert |
| GET | `/alerts` | List all alerts |

---

## Setup & Installation

### Prerequisites

- Docker & Docker Compose
- FlatTrade account (for live data)

### 1. Clone and configure

```bash
git clone https://github.com/SauravShadow/python_interface_for_analysing_the_stock_data.git
cd python_interface_for_analysing_the_stock_data
cp .env.example .env
# Edit .env with your database credentials and settings
```

### 2. Start all services

```bash
docker compose up -d
```

This starts:
- `postgres` — TimescaleDB on port 5432
- `redis` — Celery message broker on port 6379
- `backend` — FastAPI on port 8000
- `celery-worker` — Handles ML training tasks
- `frontend` — Next.js on port 3000
- `nginx` — Reverse proxy on port 80

### 3. Open the app

Navigate to `http://localhost` (or your configured domain).

### Recommended Workflow

```mermaid
graph LR
    A[1. Login\n/login] --> B[2. Add Stocks\n/stocks]
    B --> C[3. Download Data\n/data]
    C --> D[4. Analyse\n/analysis]
    D --> E[5. Train ML Model\n/ml/train]
    E --> F[6. Watch Live\n/live]
```

---

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Async PostgreSQL connection URL | `postgresql+asyncpg://user:pass@postgres:5432/quantdash` |
| `POSTGRES_USER` | PostgreSQL username | `postgres` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `quantdash` |
| `POSTGRES_DB` | Database name | `quantdash` |
| `SECRET_KEY` | App secret key | `change_me_in_production` |
| `CORS_ORIGINS` | Allowed CORS origins (JSON array) | `["http://localhost"]` |
| `DATA_DIR` | OHLCV data directory | `/app/data` |
| `ML_MODELS_DIR` | Trained model files directory | `/app/ml_models` |
| `REDIS_URL` | Redis connection URL (Celery) | `redis://redis:6379/0` |
| `TOKEN_EXPIRY_HOUR_IST` | FlatTrade token expiry hour (IST) | `5` |

---

## Deployment

The app is deployed on a single Linux host behind Nginx. Key Nginx settings:

- `proxy_buffering off` on `/api/` — required for Server-Sent Events (SSE)
- WebSocket upgrade headers on `/api/live/ws/`
- 600 s proxy timeout for long-running downloads and training
- 3600 s WebSocket timeout for live tick connections

There is currently no CI/CD pipeline. Deploy by pulling the latest image and running `docker compose up -d`.
