"""
worker.py — Celery application instance.

Import this module to get the configured Celery app.
The celery-worker container runs:
    celery -A worker worker --loglevel=info
"""
from celery import Celery
from config import settings

celery_app = Celery(
    "quantdash",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["tasks.ml_tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=3600,  # task results expire after 1h
)
