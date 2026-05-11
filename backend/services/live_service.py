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
from services.flattrade import flattrade_service, _ft_path

if _ft_path not in sys.path:
    sys.path.insert(0, _ft_path)


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

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    # ── FlatTrade WS ───────────────────────────────────────────────────────────

    def start_websocket(self):
        """Start the FlatTrade WebSocket connection in a background thread."""
        if self._ws_started:
            return
        self._ws_started = True
        t = threading.Thread(target=self._ws_thread, daemon=True)
        t.start()

    def _ws_thread(self):
        """Run in background thread — connects to FlatTrade and handles ticks."""
        try:
            api = flattrade_service.api
        except RuntimeError:
            print("[LiveService] Not logged in — WebSocket not started")
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
            print("[LiveService] FlatTrade WebSocket connected")

        def on_disconnect():
            print("[LiveService] FlatTrade WebSocket disconnected — reconnecting...")
            self._ws_started = False

        def on_error(msg):
            print(f"[LiveService] WebSocket error: {msg}")

        try:
            api.start_websocket(
                subscribe_callback=on_ticks,
                order_update_callback=lambda msg: None,
                socket_open_callback=on_open,
                socket_close_callback=on_disconnect,
                socket_error_callback=on_error,
            )
        except Exception as e:
            print(f"[LiveService] WebSocket start failed: {e}")
            self._ws_started = False

    def subscribe(self, exchange: str, token: str):
        """Subscribe to a symbol on FlatTrade WS."""
        if not self._ws_started:
            self.start_websocket()
        try:
            api = flattrade_service.api
            api.subscribe(api, [{"exchange": exchange, "token": token}])
        except Exception as e:
            print(f"[LiveService] Subscribe error: {e}")

    def unsubscribe(self, exchange: str, token: str):
        try:
            api = flattrade_service.api
            api.unsubscribe(api, [{"exchange": exchange, "token": token}])
        except Exception:
            pass

    # ── Tick handling ──────────────────────────────────────────────────────────

    def _handle_tick(self, tick: dict):
        token = tick.get("tk") or tick.get("token")
        if not token:
            return

        formatted = {
            "type": "tick",
            "token": token,
            "symbol": tick.get("ts", ""),
            "ltp": float(tick.get("lp", 0)),
            "open": float(tick.get("op", 0)),
            "high": float(tick.get("h", 0)),
            "low": float(tick.get("l", 0)),
            "close": float(tick.get("c", 0)),
            "volume": int(tick.get("v", 0)),
            "change_pct": float(tick.get("pc", 0)),
            "timestamp": datetime.utcnow().isoformat(),
        }
        self._latest[token] = formatted
        self._check_alerts(token, formatted["ltp"])

        # Broadcast to frontend clients asynchronously
        if self._loop and not self._loop.is_closed():
            asyncio.run_coroutine_threadsafe(
                self._broadcast(token, formatted), self._loop
            )

    async def _broadcast(self, token: str, data: dict):
        clients = self._clients.get(token, [])[:]
        dead = []
        for ws in clients:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        # Clean up disconnected clients
        for ws in dead:
            self._disconnect_client(token, ws)

    # ── Frontend WebSocket management ──────────────────────────────────────────

    async def connect_client(self, token: str, ws: WebSocket, exchange: str = "NSE"):
        await ws.accept()
        with self._lock:
            if token not in self._clients:
                self._clients[token] = []
                self.subscribe(exchange, token)
            self._clients[token].append(ws)

        # Send latest known tick immediately (if available)
        if token in self._latest:
            await ws.send_json(self._latest[token])

        # Keep connection alive
        try:
            while True:
                msg = await ws.receive_text()
                # Handle ping/pong or unsubscribe
                if msg == "ping":
                    await ws.send_text("pong")
        except Exception:
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

    def register_multiplex_client(self, token: str, ws: WebSocket, exchange: str = "NSE"):
        """Register an already-accepted WebSocket as a listener for `token`."""
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
                print(f"[ALERT] {alert['symbol']} LTP={ltp} crossed {direction} threshold. {alert.get('note','')}")
                # Broadcast alert to all clients subscribed to this token
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
