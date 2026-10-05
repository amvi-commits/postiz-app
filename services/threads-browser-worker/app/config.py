import os
from pathlib import Path
from dotenv import load_dotenv

# Base directory for the sidecar
BASE_DIR = Path(__file__).resolve().parent.parent

# Load .env if present in sidecar or repo root
load_dotenv(BASE_DIR / ".env")

class Settings:
    HOST: str = os.getenv("THREADS_BROWSER_SERVICE_HOST", "127.0.0.1")
    PORT: int = int(os.getenv("THREADS_BROWSER_SERVICE_PORT", "8017"))
    HEADLESS: bool = os.getenv("THREADS_BROWSER_HEADLESS", "true").lower() in ("true", "1", "yes")
    TIMEOUT_MS: int = int(os.getenv("THREADS_BROWSER_TIMEOUT_MS", "60000"))
    SERVICE_KEY: str | None = os.getenv("THREADS_BROWSER_SERVICE_KEY") or None
    MEDIA_ALLOWED_HOSTS: list[str] = [
        h.strip().lower() for h in os.getenv("THREADS_MEDIA_ALLOWED_HOSTS", "localhost,127.0.0.1,host.docker.internal").split(",") if h.strip()
    ]
    MEDIA_MAX_BYTES: int = int(os.getenv("THREADS_MEDIA_MAX_BYTES", str(20 * 1024 * 1024)))  # 20MB default

    SESSIONS_DIR: Path = Path(os.getenv("THREADS_BROWSER_SESSIONS_DIR", str(BASE_DIR / "sessions"))).resolve()
    DIAGNOSTICS_DIR: Path = Path(os.getenv("THREADS_BROWSER_DIAGNOSTICS_DIR", str(BASE_DIR / "diagnostics"))).resolve()

settings = Settings()

# Ensure directories exist
settings.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
settings.DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)
