"""Gunicorn entrypoint: ``gunicorn explorer.wsgi:app``."""

from explorer.app import create_app
from explorer.config import Settings

app = create_app(Settings.from_env())
