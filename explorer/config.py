"""Process configuration. Everything the explorer needs comes from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


@dataclass
class Settings:
    data_dir: str = "data"
    host: str = "0.0.0.0"
    port: int = 8000
    graph_source: str = "rgs"
    rgs_url: str = "https://rapidsync.lightningdevkit.org/snapshot/0"
    mempool_api: str = "https://mempool.space/api"
    refresh_seconds: int = 10800
    enrich_per_refresh: int = 6000
    capacity_pages_per_refresh: int = 800
    enrich_rps: float = 3.0
    metrics_samples: int = 64
    close_lookups_per_refresh: int = 150
    rank_history_top: int = 200
    # Funding-output capacity resolver (explorer/funding.py).
    funding_rps: float = 2.0
    funding_requests_per_pass: int = 600
    funding_idle_seconds: int = 900
    funding_start_delay: float = 20.0
    lnd_rest_url: str = ""
    lnd_macaroon_hex: str = ""
    lnd_macaroon_path: str = ""
    lnd_insecure: bool = True
    graph_file: str = ""
    plausible_domain: str = ""
    plausible_src: str = "https://plausible.io/js/script.js"
    disable_refresh: bool = False
    web_dir: str = ""

    @property
    def db_path(self) -> str:
        return str(Path(self.data_dir) / "explorer.sqlite")

    def macaroon_hex(self) -> str:
        if self.lnd_macaroon_hex:
            return self.lnd_macaroon_hex.strip()
        if self.lnd_macaroon_path:
            raw = Path(self.lnd_macaroon_path).read_bytes()
            try:
                text = raw.decode("ascii").strip()
            except UnicodeDecodeError:
                text = ""
            if text and all(ch in "0123456789abcdefABCDEF" for ch in text):
                return text.lower()
            return raw.hex()
        return ""

    @classmethod
    def from_env(cls) -> "Settings":
        root = Path(__file__).resolve().parent.parent
        return cls(
            data_dir=os.environ.get("DATA_DIR", "data"),
            host=os.environ.get("HOST", "0.0.0.0"),
            port=_int("PORT", 8000),
            graph_source=os.environ.get("GRAPH_SOURCE", "rgs").strip().lower() or "rgs",
            rgs_url=os.environ.get(
                "RGS_URL",
                "https://rapidsync.lightningdevkit.org/snapshot/0",
            ).strip(),
            mempool_api=os.environ.get("MEMPOOL_API", "https://mempool.space/api").strip(),
            refresh_seconds=_int("REFRESH_SECONDS", 10800),
            enrich_per_refresh=_int("ENRICH_PER_REFRESH", 6000),
            capacity_pages_per_refresh=_int("CAPACITY_PAGES_PER_REFRESH", 800),
            enrich_rps=float(os.environ.get("ENRICH_RPS", "3") or "3"),
            metrics_samples=_int("METRICS_SAMPLES", 64),
            close_lookups_per_refresh=_int("CLOSE_LOOKUPS_PER_REFRESH", 150),
            rank_history_top=_int("RANK_HISTORY_TOP", 200),
            funding_rps=float(os.environ.get("FUNDING_RPS", "2") or "2"),
            funding_requests_per_pass=_int("FUNDING_REQUESTS_PER_PASS", 600),
            funding_idle_seconds=_int("FUNDING_IDLE_SECONDS", 900),
            funding_start_delay=float(os.environ.get("FUNDING_START_DELAY", "20") or "20"),
            lnd_rest_url=os.environ.get("LND_REST_URL", "").strip(),
            lnd_macaroon_hex=os.environ.get("LND_MACAROON_HEX", "").strip(),
            lnd_macaroon_path=os.environ.get("LND_MACAROON_PATH", "").strip(),
            lnd_insecure=_flag("LND_INSECURE", True),
            graph_file=os.environ.get("GRAPH_FILE", "").strip(),
            plausible_domain=os.environ.get("PLAUSIBLE_DOMAIN", "").strip(),
            plausible_src=os.environ.get(
                "PLAUSIBLE_SRC", "https://plausible.io/js/script.js"
            ).strip(),
            disable_refresh=_flag("EXPLORER_DISABLE_REFRESH", False),
            web_dir=os.environ.get("WEB_DIR", str(root / "web")),
        )
