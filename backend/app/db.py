"""Database schema and engine (PostgreSQL in production, a SQLite file for local development).

Every row a person keeps carries the account that owns it, and every query in store.py and network.py filters
by it: permissions are enforced here on the server, never only in the interface.

Tables are created on startup when missing. They are not altered afterwards, so later schema changes need a
migration (Alembic is the usual tool) before they are deployed.
"""
from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy import event

metadata = sa.MetaData()
ms = sa.BigInteger  # epoch milliseconds, as the existing API already uses


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


# ---------------------------------------------------------------- accounts
users = sa.Table(
    "users", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("orcid", sa.String(19), unique=True),  # 0000-0002-1825-0097
    sa.Column("affiliation", sa.String(300), nullable=False, server_default=""),
    sa.Column("bio", sa.Text, nullable=False, server_default=""),
    sa.Column("interests_json", sa.Text, nullable=False, server_default="[]"),
    # Private: used only to send notifications, never shown to other people
    sa.Column("notify_email", sa.String(320)),
    sa.Column("is_admin", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", ms, nullable=False),
)

sessions = sa.Table(
    "sessions", metadata,
    # SHA-256 of the cookie value; the value itself is never stored
    sa.Column("token_hash", sa.String(64), primary_key=True),
    sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("created_at", ms, nullable=False),
    sa.Column("expires_at", ms, nullable=False),
)

# Rolling-window rate limits; counted in the database so they hold across server instances
usage_events = sa.Table(
    "usage_events", metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    sa.Column("kind", sa.String(30), nullable=False),
    sa.Column("created_at", ms, nullable=False),
    sa.Index("usage_lookup", "user_id", "kind", "created_at"),
)

# ---------------------------------------------------------------- private research (Library)
projects = sa.Table(
    "projects", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("name", sa.String(120), nullable=False),
    sa.Column("description", sa.String(500), nullable=False, server_default=""),
    sa.Column("notes", sa.Text, nullable=False, server_default=""),
    sa.Column("archived", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", ms, nullable=False),
    sa.Column("updated_at", ms, nullable=False),
)

# People a project is shared with. The owner is not listed here; members can read everything in the project
# and add their own research, sources and files to it.
project_members = sa.Table(
    "project_members", metadata,
    sa.Column("project_id", sa.String(40), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True),
    sa.Column("added_by", sa.String(40)),
    sa.Column("added_at", ms, nullable=False),
)

reports = sa.Table(
    "reports", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("project_id", sa.String(40), sa.ForeignKey("projects.id", ondelete="SET NULL"), index=True),
    sa.Column("title", sa.String(200), nullable=False),
    sa.Column("question", sa.Text, nullable=False, server_default=""),
    sa.Column("mode", sa.String(40), nullable=False, server_default="All web"),
    sa.Column("time_label", sa.String(60), nullable=False, server_default=""),
    sa.Column("sources_count", sa.Integer, nullable=False, server_default="0"),
    sa.Column("report_text", sa.Text, nullable=False, server_default=""),
    sa.Column("sources_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("reasoning", sa.Text, nullable=False, server_default=""),
    sa.Column("models_json", sa.Text, nullable=False, server_default="{}"),
    sa.Column("coverage_json", sa.Text, nullable=False, server_default="{}"),
    sa.Column("followups_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("archived", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("deleted", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", ms),
    # Insertion order, for a stable sort among reports created in the same millisecond
    sa.Column("seq", ms, nullable=False),
)

saved_sources = sa.Table(
    "saved_sources", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("project_id", sa.String(40), sa.ForeignKey("projects.id", ondelete="CASCADE"), index=True),
    sa.Column("report_id", sa.String(40), sa.ForeignKey("reports.id", ondelete="SET NULL")),
    sa.Column("url", sa.Text, nullable=False),
    sa.Column("title", sa.String(300), nullable=False),
    sa.Column("source_json", sa.Text, nullable=False),
    sa.Column("created_at", ms, nullable=False),
)

attachments = sa.Table(
    "attachments", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    sa.Column("project_id", sa.String(40), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("blob_key", sa.String(200), nullable=False),
    sa.Column("filename", sa.String(200), nullable=False),
    sa.Column("content_type", sa.String(100), nullable=False),
    sa.Column("size", sa.Integer, nullable=False),
    sa.Column("created_at", ms, nullable=False),
)

exports = sa.Table(
    "exports", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("project_id", sa.String(40), sa.ForeignKey("projects.id", ondelete="CASCADE"), index=True),
    sa.Column("report_id", sa.String(40), sa.ForeignKey("reports.id", ondelete="SET NULL")),
    sa.Column("kind", sa.String(40), nullable=False),
    sa.Column("filename", sa.String(200), nullable=False),
    sa.Column("content", sa.Text),
    sa.Column("created_at", ms, nullable=False),
)

paper_templates = sa.Table(
    "paper_templates", metadata,
    sa.Column("id", sa.String(80), primary_key=True),
    sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("name", sa.String(120), nullable=False),
    sa.Column("venue", sa.String(200), nullable=False, server_default=""),
    sa.Column("doc_class", sa.Text, nullable=False),
    sa.Column("preamble", sa.Text, nullable=False),
    sa.Column("created_at", ms, nullable=False),
)

# ---------------------------------------------------------------- Network (public-facing)
organizations = sa.Table(
    "organizations", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("name", sa.String(200), nullable=False),
    # Research Organization Registry id, e.g. 05m7pjf47 (https://ror.org/05m7pjf47)
    sa.Column("ror_id", sa.String(9), unique=True),
    sa.Column("website", sa.String(300), nullable=False, server_default=""),
    sa.Column("description", sa.Text, nullable=False, server_default=""),
    # Set only by a site admin after checking the organization is who it says it is
    sa.Column("verified", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_by", sa.String(40), sa.ForeignKey("users.id", ondelete="SET NULL")),
    sa.Column("created_at", ms, nullable=False),
)

org_members = sa.Table(
    "org_members", metadata,
    sa.Column("org_id", sa.String(40), sa.ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True),
    sa.Column("role", sa.String(10), nullable=False),  # admin | member
    sa.Column("added_at", ms, nullable=False),
)

works = sa.Table(
    "works", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("org_id", sa.String(40), sa.ForeignKey("organizations.id", ondelete="SET NULL"), index=True),
    sa.Column("title", sa.String(300), nullable=False),
    sa.Column("abstract", sa.Text, nullable=False, server_default=""),
    sa.Column("authors_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("tags_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("license", sa.String(20), nullable=False),
    sa.Column("visibility", sa.String(10), nullable=False, server_default="private"),  # private | request | open
    # A work claimed from elsewhere links to the original instead of hosting a file
    sa.Column("external_url", sa.Text),
    sa.Column("doi", sa.String(200)),
    sa.Column("claimed", sa.Boolean, nullable=False, server_default=sa.false()),
    # For a claimed work: what confirmed the claimant is an author, shown on the work page
    sa.Column("claim_evidence", sa.Text),
    sa.Column("taken_down", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("takedown_reason", sa.Text),
    sa.Column("created_at", ms, nullable=False),
    sa.Column("updated_at", ms, nullable=False),
    sa.Index("works_discover", "visibility", "taken_down", "updated_at"),
)

work_versions = sa.Table(
    "work_versions", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("work_id", sa.String(40), sa.ForeignKey("works.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("version", sa.Integer, nullable=False),
    sa.Column("blob_key", sa.String(200), nullable=False),
    sa.Column("filename", sa.String(200), nullable=False),
    sa.Column("content_type", sa.String(100), nullable=False),
    sa.Column("size", sa.Integer, nullable=False),
    sa.Column("sha256", sa.String(64), nullable=False),
    sa.Column("note", sa.String(500), nullable=False, server_default=""),
    sa.Column("created_by", sa.String(40), nullable=False),
    sa.Column("created_at", ms, nullable=False),
    sa.UniqueConstraint("work_id", "version"),
)

# People who may read a work that is not open: invited by the owner, or approved through a request
work_access = sa.Table(
    "work_access", metadata,
    sa.Column("work_id", sa.String(40), sa.ForeignKey("works.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True),
    sa.Column("granted_by", sa.String(40)),
    sa.Column("granted_at", ms, nullable=False),
)

# Append-only, hash-chained log of who uploaded which bytes when. Rows are never updated or deleted (PostgreSQL
# enforces this with a trigger), and keep their work and account ids as plain values so they outlive both.
# Each row's hash covers the previous row's hash, so altering or removing any row breaks every later link.
ownership_records = sa.Table(
    "ownership_records", metadata,
    sa.Column("seq", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("id", sa.String(40), nullable=False, unique=True),
    sa.Column("event", sa.String(10), nullable=False),  # upload | claim
    sa.Column("work_id", sa.String(40), nullable=False, index=True),
    sa.Column("version_id", sa.String(40)),
    sa.Column("user_id", sa.String(40), nullable=False),
    sa.Column("orcid", sa.String(19)),
    sa.Column("sha256", sa.String(64), nullable=False),
    sa.Column("size", sa.Integer, nullable=False),
    sa.Column("filename", sa.String(200), nullable=False),
    sa.Column("created_at", ms, nullable=False),
    sa.Column("prev_hash", sa.String(64), nullable=False, unique=True),
    sa.Column("record_hash", sa.String(64), nullable=False, unique=True),
)

access_requests = sa.Table(
    "access_requests", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("work_id", sa.String(40), sa.ForeignKey("works.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("requester_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("kind", sa.String(12), nullable=False),  # access | collaborate
    sa.Column("message", sa.String(1000), nullable=False, server_default=""),
    sa.Column("status", sa.String(10), nullable=False, server_default="pending"),  # pending | accepted | declined | withdrawn
    sa.Column("response", sa.String(1000), nullable=False, server_default=""),
    # The shared project an accepted collaboration opened
    sa.Column("project_id", sa.String(40), sa.ForeignKey("projects.id", ondelete="SET NULL")),
    sa.Column("created_at", ms, nullable=False),
    sa.Column("decided_at", ms),
)

notifications = sa.Table(
    "notifications", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    sa.Column("kind", sa.String(40), nullable=False),
    sa.Column("data_json", sa.Text, nullable=False, server_default="{}"),
    sa.Column("read", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", ms, nullable=False),
)

blocks = sa.Table(
    "blocks", metadata,
    sa.Column("blocker_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("blocked_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("created_at", ms, nullable=False),
)

abuse_reports = sa.Table(
    "abuse_reports", metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("reporter_id", sa.String(40), sa.ForeignKey("users.id", ondelete="SET NULL")),
    sa.Column("target_kind", sa.String(10), nullable=False),  # work | user
    sa.Column("target_id", sa.String(40), nullable=False),
    sa.Column("reason", sa.String(30), nullable=False),
    sa.Column("details", sa.String(2000), nullable=False, server_default=""),
    sa.Column("status", sa.String(10), nullable=False, server_default="open"),  # open | resolved
    sa.Column("resolution", sa.String(1000), nullable=False, server_default=""),
    sa.Column("resolved_by", sa.String(40)),
    sa.Column("created_at", ms, nullable=False),
)

# Makes ownership records immutable at the database level, whatever code runs against it
_PG_IMMUTABLE = """
CREATE OR REPLACE FUNCTION ownership_records_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ownership records are append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ownership_records_no_change ON ownership_records;
CREATE TRIGGER ownership_records_no_change BEFORE UPDATE OR DELETE ON ownership_records
  FOR EACH ROW EXECUTE FUNCTION ownership_records_immutable();
"""
_SQLITE_IMMUTABLE = [
    """CREATE TRIGGER IF NOT EXISTS ownership_records_no_update BEFORE UPDATE ON ownership_records
       BEGIN SELECT RAISE(ABORT, 'ownership records are append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS ownership_records_no_delete BEFORE DELETE ON ownership_records
       BEGIN SELECT RAISE(ABORT, 'ownership records are append-only'); END""",
]


def database_url(root: Path) -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        path = Path(os.getenv("NEMOSEARCH_DB", root / "data" / "nemosearch-v2.db"))
        path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{path.as_posix()}"
    # Hosts hand out postgres:// URLs; SQLAlchemy needs the driver named
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def create_db_engine(url: str) -> sa.Engine:
    if url.startswith("sqlite"):
        engine = sa.create_engine(url, connect_args={"check_same_thread": False})

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(conn, _record):  # noqa: ANN001
            cur = conn.cursor()
            cur.execute("PRAGMA foreign_keys = ON")
            cur.execute("PRAGMA journal_mode = WAL")
            cur.close()

        return engine
    # Serverless platforms put a connection pooler (PgBouncer and similar) in front of PostgreSQL. Those break
    # server-side prepared statements, so psycopg is told never to prepare; pre-ping drops connections the
    # pooler or the platform closed while the instance was frozen.
    return sa.create_engine(
        url, pool_pre_ping=True, pool_size=5, max_overflow=5, pool_recycle=300,
        connect_args={"prepare_threshold": None},
    )


# Columns added after a table first shipped: (table, column, DDL type). create_all never alters existing tables.
_ADDED_COLUMNS = [("works", "claim_evidence", "TEXT")]


def init_schema(engine: sa.Engine) -> None:
    metadata.create_all(engine)
    existing = sa.inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in _ADDED_COLUMNS:
            if column not in {c["name"] for c in existing.get_columns(table)}:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            conn.exec_driver_sql(_PG_IMMUTABLE)
        elif engine.dialect.name == "sqlite":
            for stmt in _SQLITE_IMMUTABLE:
                conn.exec_driver_sql(stmt)
