FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8000 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN useradd --create-home --uid 10001 explorer \
    && mkdir -p /data \
    && chown explorer:explorer /data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY explorer ./explorer
COPY web/index.html web/logo.svg web/favicon.png web/apple-touch-icon.png web/icon-192.png web/manifest.webmanifest ./web/
COPY web/fonts ./web/fonts
COPY web/static ./web/static

USER explorer
EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "--timeout", "120", "--access-logfile", "-", "explorer.wsgi:app"]
