"""Errors the data layer raises, each mapped to one HTTP status in main.py, and the shared rate limiter."""
from __future__ import annotations

import sqlalchemy as sa

from .db import now_ms, usage_events

DAY_MS = 24 * 3600 * 1000


class NotFound(Exception):
    """404. Also used for things that exist but the caller may not see, so their existence is not revealed."""


class Forbidden(Exception):
    """403: the caller can see this but may not change it."""


class Invalid(Exception):
    """422: the request is understood but its content is not acceptable."""


class Conflict(Exception):
    """409: the request clashes with the current state (e.g. a request that is already pending)."""


class RateLimited(Exception):
    """429: the account reached a daily limit."""


def consume(conn: sa.Connection, user_id: str, kind: str, per_day: int, what: str) -> None:
    """Counts one use of `kind` against a rolling 24-hour limit, or raises RateLimited."""
    since = now_ms() - DAY_MS
    used = conn.execute(
        sa.select(sa.func.count()).select_from(usage_events).where(
            usage_events.c.user_id == user_id, usage_events.c.kind == kind, usage_events.c.created_at > since
        )
    ).scalar_one()
    if used >= per_day:
        raise RateLimited(f"You've reached today's limit of {per_day} {what}. Try again tomorrow.")
    conn.execute(usage_events.insert().values(user_id=user_id, kind=kind, created_at=now_ms()))
