"""
services/live_service.py — FlatTrade WebSocket manager + frontend broadcast.

Architecture:
  1. LiveService connects to FlatTrade's WSS using NorenRestApiPy
  2. Subscriptions are maintained per symbol token
  3. Tick data is broadcast to all connected frontend WebSocket clients
  4. Price alerts are checked on every tick

The FlatTrade WebSocket runs in a background thread (NorenRestApiPy uses threads).
Frontend clients connect via FastAPI WebSocket endpoints.
"""

import sys
import asyncio
import threading
import json
from datetime import datetime
from typing import Optional
from fastapi import WebSocket

from config import settings
from logger import get_logger
from services.flattrade import flattrade_service, _ft_path

if _ft_path not in sys.path:
    sys.path.insert(0, _ft_path)

log = get_logger("services.live_service")


class LiveService:
    def __init__(self):
        # frontend WebSocket clients: { token: [WebSocket, ...] }
        self._clients: dict[str, list[WebSocket]] = {}
        self._lock = threading.Lock()
        self._ws_started = False
        # price alerts: { token: [{"above": float|None, "below": float|None}, ...] }
        self._alerts: dict[str, list[dict]] = {}
        # latest tick per token
        self._latest: dict[str, dict] = {}
        # asyncio event loop reference (set from main thread)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        # tick counter for periodic log summaries
        self._tick_count = 0

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        log.debug("Event loop reference stored")

    # ── FlatTrade WS ───────────────────────────────────────────────────────────

    def start_websocket(self):
        """Start the FlatTrade WebSocket connection in a background thread."""
        if self._ws_started:
            log.debug("WebSocket already started — skipping duplicate start")
            return
        self._ws_started = True
        log.info("Starting FlatTrade WebSocket in background thread...")
        t = threading.Thread(target=self._ws_thread, daemon=True)
        t.start()

    def _ws_thread(self):
        """Run in background thread — connects to FlatTrade and handles ticks."""
        log.info("[WS-thread] Connecting to FlatTrade WebSocket...")
        try:
            api = flattrade_service.api
        except RuntimeError:
            log.error("[WS-thread] Not logged in — WebSocket aborted")
            self._ws_started = False
            return

        def on_ticks(tick_data):
            """Called by NorenRestApiPy on each tick."""
            if isinstance(tick_data, list):
                for tick in tick_data:
                    self._handle_tick(tick)
            elif isinstance(tick_data, dict):
                self._handle_tick(tick_data)

        def on_open():
            subscribed = list(self._clients.keys())
            log.info(
                "[WS-thread] FlatTrade WebSocket connected — %d token(s) subscribed: %s",
                len(subscribed), subscribed or "none yet",
            )

        def on_disconnect():
            log.warning("[WS-thread] FlatTrade WebSocket disconnected — will reconnect on next subscribe")
            self._ws_started = False

        def on_error(msg):
            log.error("[WS-thread] WebSocket error: %s", msg)

        try:
            api.start_websocket(
                subscribe_callback=on_ticks,
                order_update_callback=lambda msg: None,
                socket_open_callback=on_open,
                socket_close_callback=on_disconnect,
                socket_error_callback=on_error,
            )
        except Exception as e:
            log.error("[WS-thread] WebSocket start failed: %s", e, exc_info=True)
            self._ws_started = False

    def subscribe(self, exchange: str, token: str):
        """Subscribe to a symbol on FlatTrade WS."""
        if not self._ws_started:
            log.info("Triggering WebSocket start before subscribe (token=%s)", token)
            self.start_websocket()
        try:
            api = flattrade_service.api
            api.subscribe([f"{exchange}|{token}"])
            log.info("Subscribed to %s:%s", exchange, token)
        except Exception as e:
            log.error("Subscribe failed for %s:%s — %s", exchange, token, e)

    def unsubscribe(self, exchange: str, token: str):
        try:
            api = flattrade_service.api
            api.unsubscribe([f"{exchange}|{token}"])
            log.info("Unsubscribed from %s:%s", exchange, token)
        except Exception:
            pass

    # ── Tick handling ──────────────────────────────────────────────────────────

    def _handle_tick(self, tick: dict):
        token = tick.get("tk") or tick.get("token")
        if not token:
            return

        ltp = float(tick.get("lp", 0))
        prev_close = float(tick.get("c", 0))
        if prev_close > 0 and ltp > 0:
            change_pct = round((ltp - prev_close) / prev_close * 100, 2)
        else:
            change_pct = float(tick.get("pc", 0))

        formatted = {
            "type": "tick",
            "token": token,
            "symbol": tick.get("ts", ""),
            "ltp": ltp,
            "open": float(tick.get("op", 0)),
            "high": float(tick.get("h", 0)),
            "low": float(tick.get("l", 0)),
            "close": prev_close,
            "volume": int(tick.get("v", 0)),
            "change_pct": change_pct,
            "timestamp": datetime.utcnow().isoformat(),
        }
        self._latest[token] = formatted

        # Log every 50th tick to avoid log spam (full detail at DEBUG level always)
        self._tick_count += 1
        log.debug(
            "Tick #%d  symbol=%s  ltp=%.2f  chg=%.2f%%  vol=%s",
            self._tick_count, formatted["symbol"], ltp, change_pct, formatted["volume"],
        )
        if self._tick_count % 50 == 0:
            log.info(
                "Tick summary: %d ticks received so far. Latest: %s @ %.2f (%.2f%%)",
                self._tick_count, formatted["symbol"], ltp, change_pct,
            )

        self._check_alerts(token, formatted["ltp"])

        # Broadcast to frontend clients asynchronously
        if self._loop and not self._loop.is_closed():
            asyncio.run_coroutine_threadsafe(
                self._broadcast(token, formatted), self._loop
            )
        else:
            log.warning("Event loop unavailable — tick for %s not broadcast", token)

    async def _broadcast(self, token: str, data: dict):
        clients = self._clients.get(token, [])[:]
        if not clients:
            return
        dead = []
        for ws in clients:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        if dead:
            log.debug("Removing %d dead client(s) for token %s", len(dead), token)
            for ws in dead:
                self._disconnect_client(token, ws)

    # ── Frontend WebSocket management ──────────────────────────────────────────

    async def connect_client(self, token: str, ws: WebSocket, exchange: str = "NSE"):
        await ws.accept()
        log.info("Frontend client connected for token=%s exchange=%s", token, exchange)
        with self._lock:
            if token not in self._clients:
                self._clients[token] = []
                self.subscribe(exchange, token)
            self._clients[token].append(ws)

        # Send latest known tick immediately (if available)
        if token in self._latest:
            log.debug("Sending cached latest tick to new client: token=%s", token)
            await ws.send_json(self._latest[token])

        # Keep connection alive
        try:
            while True:
                msg = await ws.receive_text()
                if msg == "ping":
                    await ws.send_text("pong")
        except Exception:
            log.info("Frontend client disconnected for token=%s", token)
            self._disconnect_client(token, ws)

    def _disconnect_client(self, token: str, ws: WebSocket):
        with self._lock:
            if token in self._clients:
                try:
                    self._clients[token].remove(ws)
                except ValueError:
                    pass
                if not self._clients[token]:
                    del self._clients[token]
                    log.debug("No more clients for token=%s — removed from registry", token)

    def register_multiplex_client(self, token: str, ws: WebSocket, exchange: str = "NSE"):
        """Register an already-accepted WebSocket as a listener for `token`."""
        log.debug("Multiplex subscribe: token=%s exchange=%s", token, exchange)
        with self._lock:
            if token not in self._clients:
                self._clients[token] = []
                self.subscribe(exchange, token)
            if ws not in self._clients[token]:
                self._clients[token].append(ws)
        # Push latest tick immediately if we have one
        if token in self._latest and self._loop and not self._loop.is_closed():
            asyncio.run_coroutine_threadsafe(
                self._send_one(ws, self._latest[token]), self._loop
            )

    def unregister_multiplex_client(self, token: str, ws: WebSocket):
        """Remove a WebSocket listener for `token`."""
        log.debug("Multiplex unsubscribe: token=%s", token)
        self._disconnect_client(token, ws)

    async def _send_one(self, ws: WebSocket, data: dict):
        try:
            await ws.send_json(data)
        except Exception:
            pass

    # ── Price alerts ───────────────────────────────────────────────────────────

    def add_alert(self, token: str, exchange: str, symbol: str,
                  above: Optional[float], below: Optional[float], note: str = ""):
        if token not in self._alerts:
            self._alerts[token] = []
        self._alerts[token].append({
            "above": above, "below": below,
            "symbol": symbol, "note": note, "triggered": False
        })
        log.info(
            "Alert set: %s (token=%s) above=%s below=%s note=%r",
            symbol, token, above, below, note,
        )

    def _check_alerts(self, token: str, ltp: float):
        alerts = self._alerts.get(token, [])
        for alert in alerts:
            if alert["triggered"]:
                continue
            triggered = False
            direction = None
            if alert["above"] is not None and ltp >= alert["above"]:
                triggered = True
                direction = "above"
            elif alert["below"] is not None and ltp <= alert["below"]:
                triggered = True
                direction = "below"

            if triggered:
                alert["triggered"] = True
                log.warning(
                    "ALERT TRIGGERED: %s LTP=%.2f crossed %s threshold (threshold=%.2f) — %s",
                    alert["symbol"], ltp, direction,
                    alert["above"] if direction == "above" else alert["below"],
                    alert.get("note", ""),
                )
                msg = {
                    "type": "alert",
                    "token": token,
                    "symbol": alert["symbol"],
                    "ltp": ltp,
                    "direction": direction,
                    "note": alert.get("note", ""),
                }
                if self._loop:
                    asyncio.run_coroutine_threadsafe(
                        self._broadcast(token, msg), self._loop
                    )

    def get_active_alerts(self) -> list[dict]:
        result = []
        for token, alerts in self._alerts.items():
            for a in alerts:
                result.append({"token": token, **a})
        return result

    def get_latest(self, token: str) -> Optional[dict]:
        return self._latest.get(token)


live_service = LiveService()
