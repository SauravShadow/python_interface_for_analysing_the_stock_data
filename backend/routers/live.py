"""
routers/live.py — Live market data via WebSocket + REST fallback
"""
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException

from schemas.live import AlertRequest, LiveQuote
from logger import get_logger
from services.flattrade import flattrade_service
from services.live_service import live_service

log = get_logger("routers.live")

router = APIRouter(prefix="/live", tags=["live"])


# ── Multiplex WebSocket (one conn, N symbols) ──────────────────────────────────

@router.websocket("/ws/multiplex")
async def websocket_multiplex(websocket: WebSocket):
    """
    Single WebSocket that multiplexes multiple symbol subscriptions.
    Client sends JSON messages:
      { "action": "subscribe",   "exchange": "NSE", "token": "1594" }
      { "action": "unsubscribe", "exchange": "NSE", "token": "1594" }
    Server pushes tick JSON for any subscribed token.
    """
    await websocket.accept()
    subscribed: set[str] = set()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            action = msg.get("action")
            exchange = msg.get("exchange", "NSE")
            token = str(msg.get("token", ""))

            if not token:
                continue

            if action == "subscribe" and token not in subscribed:
                subscribed.add(token)
                # Register this WS with live_service under the token
                live_service.register_multiplex_client(token, websocket, exchange)

            elif action == "unsubscribe" and token in subscribed:
                subscribed.discard(token)
                live_service.unregister_multiplex_client(token, websocket)

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up all subscriptions for this client on disconnect
        for token in list(subscribed):
            live_service.unregister_multiplex_client(token, websocket)


# ── WebSocket ──────────────────────────────────────────────────────────────────

@router.websocket("/ws/{exchange}/{token}")
async def websocket_tick(websocket: WebSocket, exchange: str, token: str):
    """
    WebSocket endpoint for live tick data.
    Frontend connects: ws://localhost:8000/live/ws/NSE/1594
    Server pushes tick JSON on every FlatTrade tick event.
    """
    if not flattrade_service.is_logged_in():
        await websocket.close(code=1008, reason="Not logged in")
        return
    try:
        await live_service.connect_client(token, websocket, exchange)
    except WebSocketDisconnect:
        pass


# ── REST fallback (polling) ────────────────────────────────────────────────────

@router.get("/quote/{exchange}/{token}")
async def get_live_quote(exchange: str, token: str) -> dict:
    """Single quote via REST (fallback for when WS isn't needed)."""
    if not flattrade_service.is_logged_in():
        raise HTTPException(status_code=401, detail="Not logged in")
    quote = flattrade_service.get_quote(exchange, token)
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not available")
    return quote


@router.get("/quotes")
async def get_multiple_quotes(tokens: str, exchange: str = "NSE") -> list[dict]:
    """
    Get quotes for multiple tokens.
    tokens: comma-separated string e.g. "1594,2885,3456"
    """
    if not flattrade_service.is_logged_in():
        raise HTTPException(status_code=401, detail="Not logged in")
    token_list = [t.strip() for t in tokens.split(",") if t.strip()]
    results = []
    for token in token_list:
        q = flattrade_service.get_quote(exchange, token)
        if q:
            results.append(q)
    return results


@router.get("/latest/{token}")
async def get_latest_tick(token: str) -> dict:
    """Get the most recently received tick for a token (from memory)."""
    tick = live_service.get_latest(token)
    if not tick:
        raise HTTPException(status_code=404, detail="No tick data received yet")
    return tick


# ── Price Alerts ───────────────────────────────────────────────────────────────

@router.post("/alerts")
async def add_alert(req: AlertRequest) -> dict:
    """Set a price alert. Triggered alerts are broadcast via WebSocket."""
    live_service.add_alert(
        token=req.token,
        exchange=req.exchange,
        symbol=req.symbol,
        above=req.above,
        below=req.below,
        note=req.note or "",
    )
    return {"status": "alert_set", "symbol": req.symbol}


@router.get("/alerts")
async def list_alerts() -> list[dict]:
    """List all configured price alerts and their triggered status."""
    return live_service.get_active_alerts()


# ── Intraday data ──────────────────────────────────────────────────────────────

@router.get("/intraday/{exchange}/{token}")
async def get_intraday(exchange: str, token: str) -> dict:
    """
    Get today's candles accumulated so far.
    Uses FlatTrade historical endpoint with today's date range (IST).
    """
    if not flattrade_service.is_logged_in():
        raise HTTPException(status_code=401, detail="Not logged in")

    from datetime import datetime, timezone, timedelta
    import pandas as pd

    # Always use IST for "today" — the exchange operates on IST
    IST = timezone(timedelta(hours=5, minutes=30))
    now_ist   = datetime.now(IST)
    today_ist = now_ist.date()
    start_ist = datetime(today_ist.year, today_ist.month, today_ist.day,
                         0, 0, 0, tzinfo=IST)
    start_ts  = int(start_ist.timestamp())
    end_ts    = int(now_ist.timestamp())

    log.info("Intraday request: %s:%s  range %s → %s IST",
             exchange, token,
             start_ist.strftime("%Y-%m-%d %H:%M"),
             now_ist.strftime("%H:%M"))

    try:
        ret = flattrade_service.get_time_price_series(exchange, token, start_ts, end_ts)
    except Exception as e:
        log.error("get_time_price_series exception for %s:%s — %s", exchange, token, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    # FlatTrade returns None, [], or a dict like {"stat":"Not_Ok","emsg":"..."} on failure
    if not ret:
        log.info("Intraday: no data returned for %s:%s (ret=%r)", exchange, token, ret)
        return {"candles": [], "count": 0}

    if not isinstance(ret, list):
        log.warning("Intraday: unexpected response type %s for %s:%s — %r",
                    type(ret).__name__, exchange, token, ret)
        return {"candles": [], "count": 0}

    df = pd.DataFrame(ret)
    rename = {"into": "open", "inth": "high", "intl": "low", "intc": "close", "intv": "volume"}
    df.rename(columns={k: v for k, v in rename.items() if k in df.columns}, inplace=True)
    for col in ["open", "high", "low", "close", "volume"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Build a numeric Unix-timestamp datetime column.
    # FlatTrade always includes `ssboe` (seconds since epoch) — use that.
    # Fall back to parsing `time` string ("HH:MM:SS DD-MM-YYYY" in IST) if needed.
    if "ssboe" in df.columns:
        df["datetime"] = pd.to_numeric(df["ssboe"], errors="coerce")
    elif "time" in df.columns:
        from datetime import timezone, timedelta as _td
        _IST = timezone(_td(hours=5, minutes=30))
        df["datetime"] = pd.to_datetime(
            df["time"], format="%H:%M:%S %d-%m-%Y", errors="coerce"
        ).apply(lambda x: int(x.replace(tzinfo=_IST).timestamp()) if pd.notna(x) else None)
        log.warning("Intraday: ssboe missing for %s:%s — parsed time string instead", exchange, token)
    else:
        log.warning("Intraday: no usable time column for %s:%s — columns=%s",
                    exchange, token, list(df.columns))
        return {"candles": [], "count": 0}

    df = df[["datetime", "open", "high", "low", "close", "volume"]].dropna(subset=["datetime"])
    df.sort_values("datetime", inplace=True)
    candles = df.to_dict(orient="records")
    log.info("Intraday: returning %d candles for %s:%s", len(candles), exchange, token)
    return {"candles": candles, "count": len(candles)}
