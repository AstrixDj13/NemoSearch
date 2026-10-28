"""Test setup: a fresh database and file folder per run, development sign-in, and no model or search calls.

    pytest backend/tests                      # SQLite
    TEST_DB=postgres pytest backend/tests     # a throwaway local PostgreSQL (needs `pip install pgserver`)
"""
from __future__ import annotations

import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

TMP = Path(tempfile.mkdtemp(prefix="nemosearch-test-"))

if os.getenv("TEST_DB") == "postgres":
    import pgserver

    _pg = pgserver.get_server(TMP / "pg", cleanup_mode="stop")
    _db = f"test_{uuid.uuid4().hex[:8]}"
    _pg.psql(f"CREATE DATABASE {_db};")
    os.environ["DATABASE_URL"] = _pg.get_uri(_db)
else:
    os.environ["DATABASE_URL"] = f"sqlite:///{(TMP / 'test.db').as_posix()}"

os.environ.update({
    "APP_ENV": "test", "APP_URL": "http://localhost:8000", "AUTH_DEV_LOGIN": "1", "MOCK_MODE": "1",
    "STORAGE_BACKEND": "local", "NEMOSEARCH_FILES": str(TMP / "files"), "SECRET_KEY": "test-secret",
    "ADMIN_ORCIDS": "0000-0002-1825-0097",
})
os.environ.pop("SMTP_HOST", None)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402

ADMIN_ORCID = "0000-0002-1825-0097"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def local_client() -> TestClient:
    """A client that looks like a browser on this machine, as the development sign-in requires."""
    return TestClient(main.app, base_url="http://localhost", client=("127.0.0.1", 50000))


def login(name: str, orcid: str = "") -> TestClient:
    client = local_client()
    r = client.post("/api/auth/dev-login", json={"name": name, "orcid": orcid})
    assert r.status_code == 200, r.text
    client.me = client.get("/api/me").json()  # type: ignore[attr-defined]
    return client


@pytest.fixture
def alice() -> TestClient:
    return login(f"Alice {uuid.uuid4().hex[:6]}")


@pytest.fixture
def bob() -> TestClient:
    return login(f"Bob {uuid.uuid4().hex[:6]}")


@pytest.fixture
def carol() -> TestClient:
    return login(f"Carol {uuid.uuid4().hex[:6]}")


@pytest.fixture
def admin() -> TestClient:
    return login("Site Admin", ADMIN_ORCID)


@pytest.fixture
def anon() -> TestClient:
    return local_client()
