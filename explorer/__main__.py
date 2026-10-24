"""Run the explorer without gunicorn: ``python -m explorer``."""

import os

from explorer.app import create_app
from explorer.config import Settings


def main() -> None:
    settings = Settings.from_env()
    application = create_app(settings)
    application.run(host=settings.host, port=settings.port, threaded=True)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    main()
