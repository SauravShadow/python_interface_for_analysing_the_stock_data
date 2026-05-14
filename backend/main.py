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
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from database import init_db
from logger import get_logger
from services.flattrade import flattrade_service
from services.live_service import live_service
from routers import (
    auth_router, stocks_router, data_router,
    analysis_router, ml_router, live_router,
)

log = get_logger("main")

_IST = timezone(timedelta(hours=5, minutes=30))


async def _daily_token_refresh():
    """
    Background task: re-validates the saved FlatTrade token every day at 05:00 IST.
    This ensures the session is live well before the market opens at 09:15 IST.
    If the token is stale, logs a warning so the user knows to re-login.
    """
    while True:
        now_ist  = datetime.now(_IST)
        target   = now_ist.replace(hour=5, minute=0, second=0, microsecond=0)
        if now_ist >= target:
            target += timedelta(days=1)

        sleep_secs = (target - now_ist).total_seconds()
        log.info(
            "Token refresh scheduler: next run at %s IST (in %.1f h)",
            target.strftime("%Y-%m-%d %H:%M:%S"), sleep_secs / 3600,
        )

        await asyncio.sleep(sleep_secs)

        log.info("=== Daily token refresh — 05:00 IST ===")
        if flattrade_service.try_load_existing_session():
            log.info("Token refresh OK — session active and ready for market open")
        else:
            log.warning(
                "Token refresh FAILED — saved token is invalid or expired. "
                "Login manually at /api/auth/start-login before market opens."
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────────────────────────────
    log.info("=== Subaru QuantDash backend starting ===")

    # 1. Init PostgreSQL tables
    log.info("Initializing database tables...")
    await init_db()
    log.info("Database tables ready")

    # 2. Restore saved FlatTrade session (if token exists from a previous run)
    log.info("Attempting to restore FlatTrade session from saved token...")
    if flattrade_service.try_load_existing_session():
        log.info("FlatTrade session restored successfully")
    else:
        log.warning("No valid FlatTrade session — login required via /api/auth/start-login")

    # 3. Pass the running event loop to LiveService so it can bridge WS threads
    live_service.set_loop(asyncio.get_event_loop())
    log.info("LiveService event loop set — ready to stream")

    # 4. Start daily 05:00 IST token refresh background task
    refresh_task = asyncio.create_task(_daily_token_refresh())
    log.info("=== Startup complete — listening for requests ===")

    yield

    # ── Shutdown ───────────────────────────────────────────────────────────────
    refresh_task.cancel()
    log.info("=== Shutting down Subaru QuantDash backend ===")


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


# ── Request / response logging middleware ──────────────────────────────────────
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    # Skip noisy health-check and static asset logs
    if not request.url.path.startswith("/api/health"):
        log.info(
            "%s %s → %d  (%.1f ms)",
            request.method, request.url.path, response.status_code, elapsed_ms,
        )
    return response


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
