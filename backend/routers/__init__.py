from .auth import router as auth_router
from .stocks import router as stocks_router
from .data import router as data_router
from .analysis import router as analysis_router
from .ml import router as ml_router
from .live import router as live_router

__all__ = [
    "auth_router", "stocks_router", "data_router",
    "analysis_router", "ml_router", "live_router",
]
