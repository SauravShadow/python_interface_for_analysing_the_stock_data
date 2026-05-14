"""
logger.py — Centralized logging for Subaru QuantDash backend.

Usage in any module:
    from logger import get_logger
    log = get_logger(__name__)
    log.info("Something happened")
    log.error("Something failed: %s", err)

Log format:
    2026-05-12 10:30:45.123 [INFO ] [services.live_service] FlatTrade WS connected

Outputs to:
  - Console  (INFO and above)
  - logs/app.log  (DEBUG and above, rotating 10 MB × 5 backups)
"""

import logging
import logging.handlers
from pathlib import Path

_LOG_DIR = Path(__file__).parent / "logs"
_LOG_DIR.mkdir(exist_ok=True)

_FMT = logging.Formatter(
    fmt="%(asctime)s.%(msecs)03d [%(levelname)-5s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

_configured: set[str] = set()


def get_logger(name: str) -> logging.Logger:
    """Return a named logger, configuring it once on first call."""
    logger = logging.getLogger(name)
    if name in _configured:
        return logger

    _configured.add(name)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False  # Don't double-log via root logger

    # ── Console handler (INFO+) ────────────────────────────────────────────────
    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(_FMT)
    logger.addHandler(console)

    # ── Rotating file handler (DEBUG+, 10 MB × 5 backups) ─────────────────────
    file_h = logging.handlers.RotatingFileHandler(
        _LOG_DIR / "app.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_h.setLevel(logging.DEBUG)
    file_h.setFormatter(_FMT)
    logger.addHandler(file_h)

    return logger
