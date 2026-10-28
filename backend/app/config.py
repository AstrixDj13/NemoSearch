"""Deployment settings, read once from the environment.

Local development needs none of them: it uses a SQLite file, files on disk and an http://localhost address.
A hosted deployment sets APP_ENV=production, which makes the server refuse to start without the settings that
keep accounts and files safe (a fixed SECRET_KEY, an https APP_URL, a real database, no development sign-in).
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from urllib.parse import urlparse


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def _flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    env: str = field(default_factory=lambda: os.getenv("APP_ENV", "development").strip().lower())
    app_url: str = field(default_factory=lambda: os.getenv("APP_URL", "http://localhost:8000").strip().rstrip("/"))
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", "").strip())
    # Signs OAuth state and local download links. Random per process when unset, which is fine for one local server.
    secret_key: str = field(default_factory=lambda: os.getenv("SECRET_KEY", "").strip())

    orcid_client_id: str = field(default_factory=lambda: os.getenv("ORCID_CLIENT_ID", "").strip())
    orcid_client_secret: str = field(default_factory=lambda: os.getenv("ORCID_CLIENT_SECRET", "").strip())
    # https://sandbox.orcid.org while testing; https://orcid.org for real accounts
    orcid_base: str = field(default_factory=lambda: os.getenv("ORCID_BASE_URL", "https://orcid.org").strip().rstrip("/"))
    # Local testing only: sign in as any name and ORCID iD without ORCID. Refused outside localhost.
    dev_login: bool = field(default_factory=lambda: _flag("AUTH_DEV_LOGIN"))
    # ORCID iDs that get the admin role (verify organizations, handle abuse reports, take works down)
    admin_orcids: set[str] = field(
        default_factory=lambda: {o.strip() for o in os.getenv("ADMIN_ORCIDS", "").split(",") if o.strip()}
    )

    session_days: int = field(default_factory=lambda: _int("SESSION_DAYS", 30))
    # Per-account limits over a rolling 24 hours; they protect model credits and other researchers' inboxes
    limit_research_per_day: int = field(default_factory=lambda: _int("LIMIT_RESEARCH_PER_DAY", 40))
    limit_uploads_per_day: int = field(default_factory=lambda: _int("LIMIT_UPLOADS_PER_DAY", 20))
    limit_requests_per_day: int = field(default_factory=lambda: _int("LIMIT_REQUESTS_PER_DAY", 15))
    max_work_bytes: int = field(default_factory=lambda: _int("MAX_WORK_MB", 25) * 1024 * 1024)

    def __post_init__(self) -> None:
        if not self.secret_key:
            self.secret_key = secrets.token_urlsafe(32)
            self._generated_secret = True
        else:
            self._generated_secret = False

    @property
    def production(self) -> bool:
        return self.env == "production"

    @property
    def secure_cookies(self) -> bool:
        return self.app_url.startswith("https://")

    @property
    def app_origin(self) -> str:
        u = urlparse(self.app_url)
        return f"{u.scheme}://{u.netloc}"

    @property
    def allowed_origins(self) -> set[str]:
        """Origins allowed to send state-changing requests: the app itself, plus the Vite dev server locally."""
        extra = {o.strip().rstrip("/") for o in os.getenv("EXTRA_ORIGINS", "").split(",") if o.strip()}
        dev = set() if self.production else {"http://localhost:3000", "http://127.0.0.1:3000"}
        return {self.app_origin} | extra | dev

    @property
    def is_local(self) -> bool:
        return urlparse(self.app_url).hostname in {"localhost", "127.0.0.1", "::1"}

    @property
    def orcid_enabled(self) -> bool:
        return bool(self.orcid_client_id and self.orcid_client_secret)

    def problems(self) -> list[str]:
        """Settings that make this deployment unsafe; the server refuses to start while any remain."""
        out = []
        if self.dev_login and not self.is_local:
            out.append("AUTH_DEV_LOGIN lets anyone sign in as anyone; it only works when APP_URL is localhost.")
        if self.production:
            if self.dev_login:
                out.append("Remove AUTH_DEV_LOGIN; it is for local development only.")
            if self._generated_secret:
                out.append("Set SECRET_KEY (a long random string) for production.")
            if not self.secure_cookies:
                out.append("APP_URL must start with https:// in production.")
            if not self.database_url.startswith(("postgres://", "postgresql")):
                out.append("Set DATABASE_URL to a PostgreSQL database for production.")
            if os.getenv("STORAGE_BACKEND", "local").strip().lower() != "s3":
                out.append("Set STORAGE_BACKEND=s3 (and the S3_* settings) for production; local disk does not persist on hosted platforms.")
            if not self.orcid_enabled:
                out.append("Set ORCID_CLIENT_ID and ORCID_CLIENT_SECRET; ORCID is the only way to sign in.")
        return out


settings = Settings()
