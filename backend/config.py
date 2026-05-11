"""
config.py — Application Settings
Reads from .env file via pydantic-settings.
"""
import json
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    DATABASE_URL: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/flattrade_dashboard"
    )
    FLATTRADE_PROJECT_PATH: str = (
        "/home/subaru/projects/FlatTrade_API-ReadyToUse"
    )
    ML_MODELS_DIR: str = "./ml_models"
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]
    SECRET_KEY: str = "change_me_in_production"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
