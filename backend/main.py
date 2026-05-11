"""
main.py — FastAPI application entry point

Startup sequence:
  1. Create all PostgreSQL tables (if not existing)
  2. Try to restore a saved FlatTrade session token
  3. Set the asyncio event loop reference in LiveService (for thread→async bridging)
  4. Register all routers under /api prefix

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from database import init_db
from services.flattrade import flattrade_service
from services.live_service import live_service
from routers import (
    auth_router, stocks_router, data_router,
    analysis_router, ml_router, live_router,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────────────────────────────
    print("🚀 Starting Python Intelligence Dashboard backend...")

    # 1. Init PostgreSQL tables
    await init_db()
    print("✅ Database tables ready")

    # 2. Restore saved FlatTrade session (if token exists from a previous run)
    if flattrade_service.try_load_existing_session():
        print("✅ FlatTrade session restored from saved token")
    else:
        print("⚠  No valid FlatTrade session — login via /api/auth/start-login")

    # 3. Pass the running event loop to LiveService so it can bridge WS threads
    live_service.set_loop(asyncio.get_event_loop())
    print("✅ LiveService event loop set")

    yield

    # ── Shutdown ───────────────────────────────────────────────────────────────
    print("👋 Shutting down...")


app = FastAPI(
    title="Python Intelligence Dashboard API",
    description="FlatTrade data, analysis, ML and live trading API",
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS — allow Next.js frontend ─────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ────────────────────────────────────────────────────────────────────
app.include_router(auth_router,     prefix="/api")
app.include_router(stocks_router,   prefix="/api")
app.include_router(data_router,     prefix="/api")
app.include_router(analysis_router, prefix="/api")
app.include_router(ml_router,       prefix="/api")
app.include_router(live_router,     prefix="/api")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "logged_in": flattrade_service.is_logged_in(),
        "token_age_hours": flattrade_service.get_token_age_hours(),
    }
