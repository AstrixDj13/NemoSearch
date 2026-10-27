"""Shared plumbing for scholarly-search connectors: results with provenance, caching, throttling and retries.

A connector turns one query into a list of `ScholarlyWork`s and records exactly what it sent
(`QueryRecord`) so a research run can explain its coverage. Connectors never invent results: on
failure they raise `ConnectorError` and the caller reports the gap.
"""
from __future__ import annotations

import asyncio
import email.utils
import logging
import random
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional

import httpx

log = logging.getLogger("nemosearch.connectors")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class ConnectorError(Exception):
    """Retrieval failed after bounded retries; `transient` is False for errors retrying won't fix."""

    def __init__(self, message: str, transient: bool = True) -> None:
        super().__init__(message)
        self.transient = transient


@dataclass
class ScholarlyWork:
    """Bibliographic metadata for one work, exactly as the provider returned it."""
    connector: str            # e.g. "openalex"
    source_id: str            # the provider's own identifier, e.g. https://openalex.org/W2741809807
    title: str
    authors: list[str]
    year: Optional[int]
    venue: str
    doi: str                  # bare DOI ("10.1000/xyz"), or ""
    url: str                  # canonical URL: DOI resolver when there is a DOI, else the provider's landing page
    abstract: str             # "" when the provider has no abstract
    work_type: str            # provider vocabulary, e.g. "article", "preprint", "review"
    status: str               # "published", "preprint", "accepted", "retracted" or "unknown"
    retrieved_at: str         # ISO-8601 UTC time the provider answered
    query: str                # the exact query string sent
    is_open_access: bool = False
    oa_url: str = ""          # where a free copy is hosted, if the provider knows one (never fetched)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class QueryRecord:
    """One request sent to a connector, kept for the run's coverage log."""
    connector: str
    query: str
    sent_at: str
    status: str = "pending"   # "ok", "cached", "failed"
    results: int = 0
    attempts: int = 0
    error: str = ""
    cached_from: str = ""     # when the cached answer was originally retrieved
    params: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


class TTLCache:
    """Small in-process cache. Entries keep their original retrieval time so provenance stays exact."""

    def __init__(self, ttl_seconds: float, max_entries: int = 512) -> None:
        self.ttl = ttl_seconds
        self.max = max_entries
        self._data: dict[str, tuple[float, object]] = {}

    def get(self, key: str):
        hit = self._data.get(key)
        if not hit:
            return None
        stored, value = hit
        if time.monotonic() - stored > self.ttl:
            self._data.pop(key, None)
            return None
        return value

    def put(self, key: str, value: object) -> None:
        if len(self._data) >= self.max:
            self._data.pop(next(iter(self._data)))  # oldest insertion first
        self._data[key] = (time.monotonic(), value)


class Throttle:
    """Spaces requests at least `interval` seconds apart across all concurrent callers."""

    def __init__(self, per_second: float) -> None:
        self.interval = 1.0 / per_second
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            delay = self._next - now
            self._next = max(now, self._next) + self.interval
        if delay > 0:
            await asyncio.sleep(delay)


def _retry_after(response: httpx.Response) -> Optional[float]:
    value = response.headers.get("Retry-After")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        parsed = email.utils.parsedate_to_datetime(value)
        return max(0.0, parsed.timestamp() - time.time()) if parsed else None


async def get_with_retry(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
    throttle: Throttle,
    record: QueryRecord,
    max_retries: int = 3,
    max_delay: float = 8.0,
    sleep: Optional[Callable[[float], Awaitable[None]]] = None,
) -> httpx.Response:
    """GET with throttling and bounded exponential backoff (1s, 2s, 4s …) on 429, 5xx and timeouts.

    Honors Retry-After when the provider sends it, but never waits longer than `max_delay` per attempt,
    so a run stays responsive; an exhausted daily budget surfaces as a failure instead of a long stall.
    """
    last = ""
    for attempt in range(max_retries + 1):
        record.attempts = attempt + 1
        await throttle.wait()
        retry_hint: Optional[float] = None
        try:
            response = await client.get(url, params=params)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            last = f"network error: {type(e).__name__}"
        else:
            if response.status_code == 200:
                return response
            if response.status_code == 429 or response.status_code >= 500:
                last = f"HTTP {response.status_code}" + (" (rate limited)" if response.status_code == 429 else "")
                retry_hint = _retry_after(response)
            else:
                detail = ""
                try:
                    detail = str(response.json().get("message") or response.json().get("error") or "")[:160]
                except Exception:  # noqa: BLE001
                    pass
                raise ConnectorError(f"HTTP {response.status_code}{': ' + detail if detail else ''}", transient=False)
        if attempt == max_retries:
            break
        delay = retry_hint if retry_hint is not None else (2 ** attempt) + random.uniform(0, 0.25)
        log.info("%s retry %d/%d for %r after %s; waiting %.1fs", record.connector, attempt + 1, max_retries,
                 record.query, last, min(delay, max_delay))
        await (sleep or asyncio.sleep)(min(delay, max_delay))
    raise ConnectorError(f"{last} after {max_retries + 1} attempts")
