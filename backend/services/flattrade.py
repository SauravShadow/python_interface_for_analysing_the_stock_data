"""
services/flattrade.py — Bridge to FlatTrade_API-ReadyToUse

Adds the FlatTrade project to sys.path, then wraps:
  - token_generator.login.get_token()   (with OTP interception)
  - api_helper.NorenApiPy               (broker API session)
  - data_manager functions              (search, quotes, historical)

The OTP interception works by temporarily monkey-patching builtins.input
so the Playwright login thread blocks until the API receives the OTP.
"""

import sys
import os
import builtins
import threading
import queue
import importlib.util
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from config import settings  # backend's config
from logger import get_logger

log = get_logger("services.flattrade")

# ── Add FlatTrade project to path ──────────────────────────────────────────────
_ft_path = settings.FLATTRADE_PROJECT_PATH
if _ft_path not in sys.path:
    sys.path.insert(0, _ft_path)


def _load_ft_config():
    """
    Load FlatTrade's config.py by file path using importlib.
    This avoids the sys.modules['config'] collision with the backend's config.py.
    """
    config_path = os.path.join(_ft_path, "config.py")
    spec = importlib.util.spec_from_file_location("flattrade_config", config_path)
    ft_config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ft_config)
    return ft_config


def _import_ft():
    """Import NorenApiPy and read credentials from FlatTrade's own config."""
    from api_helper import NorenApiPy  # noqa: E402
    ft_config = _load_ft_config()
    return NorenApiPy, ft_config.USER_ID

# ── Login state machine ────────────────────────────────────────────────────────
class LoginState:
    def __init__(self):
        self.status: str = "idle"   # idle | running | waiting_otp | done | error
        self.error: Optional[str] = None
        self.client_id: Optional[str] = None
        self._otp_queue: queue.Queue = queue.Queue()

    def reset(self):
        self.status = "idle"
        self.error = None
        self.client_id = None
        self._otp_queue = queue.Queue()

    def submit_otp(self, otp: str):
        self._otp_queue.put(otp)

    def _patched_input(self, prompt: str = "") -> str:
        """Replaces builtins.input during headless login."""
        if "OTP" in prompt.upper():
            self.status = "waiting_otp"
            # Block until submit_otp() is called (5-min timeout)
            try:
                otp = self._otp_queue.get(timeout=300)
                self.status = "completing"  # OTP received — browser is processing
                return otp
            except queue.Empty:
                raise TimeoutError("OTP not received within 5 minutes")
        return ""


class FlattradeService:
    def __init__(self):
        self._api = None
        self._token: Optional[str] = None
        self._token_loaded_at: Optional[datetime] = None
        self.login_state = LoginState()
        self._lock = threading.Lock()

    # ── Session management ─────────────────────────────────────────────────────

    def _session_file(self) -> Path:
        return Path(settings.DATA_DIR) / ".session_token"

    def load_saved_token(self) -> Optional[str]:
        p = self._session_file()
        if p.exists():
            token = p.read_text().strip()
            return token if token else None
        return None

    def save_token(self, token: str):
        self._session_file().write_text(token)

    def init_session(self, token: str) -> bool:
        """Initialize the NorenApiPy session. Returns True if valid."""
        try:
            NorenApiPy, USER_ID = _import_ft()
            api = NorenApiPy()
            api.set_session(userid=USER_ID, password="", usertoken=token)
            ret = api.get_limits()
            if ret and ret.get("stat") == "Ok":
                self._api = api
                self._token = token
                self._token_loaded_at = datetime.utcnow()
                return True
        except Exception as e:
            log.error("Session init failed: %s", e, exc_info=True)
        return False

    def try_load_existing_session(self) -> bool:
        """On startup, try to restore a saved session."""
        token = self.load_saved_token()
        if not token:
            log.info("No saved session token found")
            return False
        log.info("Found saved session token — validating...")
        ok = self.init_session(token)
        if ok:
            log.info("Session token valid — logged in")
        else:
            log.warning("Saved session token invalid or expired")
        return ok

    _IST = timezone(timedelta(hours=5, minutes=30))

    def _token_expiry_utc(self, loaded_at_utc: datetime) -> datetime:
        """
        Returns the UTC datetime when a token loaded at loaded_at_utc expires.
        FlatTrade tokens expire at TOKEN_EXPIRY_HOUR_IST (default 5 AM IST) daily.
        """
        expiry_hour = settings.TOKEN_EXPIRY_HOUR_IST
        loaded_ist = loaded_at_utc.replace(tzinfo=timezone.utc).astimezone(self._IST)
        expiry_ist = loaded_ist.replace(hour=expiry_hour, minute=0, second=0, microsecond=0)
        if loaded_ist >= expiry_ist:
            expiry_ist += timedelta(days=1)
        return expiry_ist.astimezone(timezone.utc).replace(tzinfo=None)

    def is_logged_in(self) -> bool:
        if self._api is None or self._token is None:
            return False
        if self._token_loaded_at is None:
            return False
        return datetime.utcnow() < self._token_expiry_utc(self._token_loaded_at)

    def get_token_age_hours(self) -> Optional[float]:
        if self._token_loaded_at:
            delta = datetime.utcnow() - self._token_loaded_at
            return round(delta.total_seconds() / 3600, 2)
        return None

    def get_token_hours_remaining(self) -> Optional[float]:
        if self._token_loaded_at is None:
            return None
        expiry = self._token_expiry_utc(self._token_loaded_at)
        remaining = (expiry - datetime.utcnow()).total_seconds() / 3600
        return max(0.0, round(remaining, 2))

    @property
    def api(self):
        if not self._api:
            raise RuntimeError("Not logged in. Call /api/auth/start-login first.")
        return self._api

    # ── Login flow ─────────────────────────────────────────────────────────────

    def start_login(self, password: str, pan_or_dob: str):
        """
        Starts the headless Playwright login in a background thread.
        The thread blocks at OTP step until submit_otp() is called.
        """
        with self._lock:
            if self.login_state.status == "running":
                return  # already running
            self.login_state.reset()
            self.login_state.status = "running"

        thread = threading.Thread(
            target=self._login_thread,
            args=(password, pan_or_dob),
            daemon=True,
        )
        thread.start()

    def _login_thread(self, password: str, pan_or_dob: str):
        original_input = builtins.input
        builtins.input = self.login_state._patched_input
        try:
            # Import login using importlib to ensure it uses FlatTrade's own config.
            # Temporarily evict 'config' from sys.modules so login.py's
            # "from config import API_KEY, ..." picks up FlatTrade's config.py
            # (inserted at sys.path[0]) instead of the cached backend config.
            import importlib.util as _ilu
            _cached_config = sys.modules.pop("config", None)
            try:
                login_path = os.path.join(_ft_path, "token_generator", "login.py")
                spec = _ilu.spec_from_file_location("flattrade_login", login_path)
                login_mod = _ilu.module_from_spec(spec)
                spec.loader.exec_module(login_mod)
            finally:
                # Always restore the backend config module
                if _cached_config is not None:
                    sys.modules["config"] = _cached_config
            token = login_mod.get_token(password=password, pan_or_dob=pan_or_dob)

            if token:
                self.save_token(token)
                ok = self.init_session(token)
                if ok:
                    self.login_state.status = "done"
                    ft_config = _load_ft_config()
                    self.login_state.client_id = ft_config.USER_ID
                else:
                    self.login_state.status = "error"
                    self.login_state.error = "Token obtained but session init failed"
            else:
                self.login_state.status = "error"
                self.login_state.error = "Login failed — check credentials or try again"
        except Exception as e:
            self.login_state.status = "error"
            self.login_state.error = str(e)
        finally:
            builtins.input = original_input

    def submit_otp(self, otp: str):
        self.login_state.submit_otp(otp)

    # ── Stock search ───────────────────────────────────────────────────────────

    def search_stock(self, query: str, exchange: str = "NSE") -> list[dict]:
        ret = self.api.searchscrip(exchange=exchange, searchtext=query)
        if not ret or "values" not in ret:
            return []

        def _rank(tsym: str) -> tuple:
            q = query.upper()
            t = tsym.upper()
            if t == q:
                return (0, len(t))                   # exact match
            if t == q + "-EQ" or t == q + "-BE":
                return (1, len(t))                   # standard equity suffix
            if t.startswith(q):
                return (2, len(t))                   # prefix match, shorter first
            return (3, len(t))                        # other (contains query etc.)

        values = sorted(ret["values"], key=lambda s: _rank(s["tsym"]))
        return [
            {
                "tsym": s["tsym"],
                "token": s["token"],
                "exchange": exchange,
                "cname": s.get("cname", ""),
            }
            for s in values[:15]
        ]

    # ── Live quote ─────────────────────────────────────────────────────────────

    def get_quote(self, exchange: str, token: str) -> Optional[dict]:
        log.debug("REST quote fetch: %s:%s", exchange, token)
        ret = self.api.get_quotes(exchange=exchange, token=token)
        if ret and ret.get("stat") == "Ok":
            ltp = float(ret.get("lp", 0))
            prev_close = float(ret.get("c", 0))
            if prev_close > 0 and ltp > 0:
                change_pct = round((ltp - prev_close) / prev_close * 100, 2)
            else:
                change_pct = float(ret.get("pc", 0))
            quote = {
                "symbol": ret.get("tsym"),
                "exchange": exchange,
                "token": token,
                "ltp": ltp,
                "open": float(ret.get("o", 0)),
                "high": float(ret.get("h", 0)),
                "low": float(ret.get("l", 0)),
                "close": prev_close,
                "volume": int(ret.get("v", 0)),
                "change_pct": change_pct,
                "timestamp": datetime.utcnow().isoformat(),
            }
            log.debug("Quote OK: %s ltp=%.2f chg=%.2f%%", quote["symbol"], ltp, change_pct)
            return quote
        log.warning("Quote fetch returned no data for %s:%s — stat=%s", exchange, token, ret.get("stat") if ret else "no response")
        return None

    # ── Historical data (used by data_service) ─────────────────────────────────

    def get_time_price_series(self, exchange: str, token: str,
                               start_ts: int, end_ts: int) -> Optional[list]:
        return self.api.get_time_price_series(
            exchange=exchange, token=token,
            starttime=start_ts, endtime=end_ts
        )


# Singleton instance — imported by all routers
flattrade_service = FlattradeService()
