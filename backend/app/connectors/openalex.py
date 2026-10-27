"""OpenAlex works search (https://api.openalex.org), following the provider's current API guidance:

- A free key (OPENALEX_API_KEY) is optional; it is sent as `api_key` and raises the daily budget 10×.
  Keyless use is allowed but small (about 100 searches a day), so results are cached.
- Keyless callers may make 10 requests/second; we stay well under that.
- Retry only 429 and 5xx (and timeouts) with exponential backoff; other 4xx are permanent errors.
- Boolean operators make searches far more expensive in rate terms, so queries are sent without them.

Only bibliographic metadata and the abstract are requested (`select`); full text is never fetched.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional

import httpx

from .base import ConnectorError, QueryRecord, ScholarlyWork, Throttle, TTLCache, get_with_retry, utc_now

log = logging.getLogger("nemosearch.connectors.openalex")

API = "https://api.openalex.org/works"
FIELDS = ",".join([
    "id", "doi", "display_name", "publication_year", "type", "authorships", "primary_location",
    "abstract_inverted_index", "open_access", "best_oa_location", "is_retracted",
])
MAX_AUTHORS = 25


def clean_query(query: str) -> str:
    """Plain keywords: no Boolean operators, wildcards or search syntax that changes cost or fails with 400."""
    q = re.sub(r"[^\w\s\-.'/]", " ", query)
    q = re.sub(r"\b(AND|OR|NOT)\b", lambda m: m.group(1).lower(), q)
    return re.sub(r"\s+", " ", q).strip()[:300]


def _abstract(inverted: Optional[dict]) -> str:
    if not inverted:
        return ""
    positions = [(pos, word) for word, spots in inverted.items() for pos in spots]
    return " ".join(word for _, word in sorted(positions))


def _status(work: dict) -> str:
    if work.get("is_retracted"):
        return "retracted"
    loc = work.get("primary_location") or {}
    source_type = ((loc.get("source") or {}).get("type") or "").lower()
    version = loc.get("version") or ""
    if work.get("type") == "preprint" or version == "submittedVersion" or source_type == "repository":
        return "preprint"
    if version == "acceptedVersion":
        return "accepted"
    if version == "publishedVersion" or source_type in {"journal", "conference", "book series", "ebook platform"}:
        return "published"
    return "unknown"


def to_work(item: dict, query: str, retrieved_at: str) -> Optional[ScholarlyWork]:
    title = (item.get("display_name") or "").strip()
    source_id = item.get("id") or ""
    if not title or not source_id:
        return None  # nothing we could cite honestly
    loc = item.get("primary_location") or {}
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", item.get("doi") or "", flags=re.I)
    oa = item.get("open_access") or {}
    best_oa = item.get("best_oa_location") or {}
    authors = [
        (a.get("author") or {}).get("display_name") or a.get("raw_author_name") or ""
        for a in item.get("authorships") or []
    ]
    return ScholarlyWork(
        connector="openalex",
        source_id=source_id,
        title=title,
        authors=[a for a in authors if a][:MAX_AUTHORS],
        year=item.get("publication_year"),
        venue=((loc.get("source") or {}).get("display_name") or "").strip(),
        doi=doi,
        url=f"https://doi.org/{doi}" if doi else (loc.get("landing_page_url") or source_id),
        abstract=_abstract(item.get("abstract_inverted_index")),
        work_type=item.get("type") or "",
        status=_status(item),
        retrieved_at=retrieved_at,
        query=query,
        is_open_access=bool(oa.get("is_oa")),
        oa_url=best_oa.get("landing_page_url") or best_oa.get("pdf_url") or oa.get("oa_url") or "",
    )


class OpenAlexConnector:
    name = "openalex"
    label = "OpenAlex"

    def __init__(self, client: Optional[httpx.AsyncClient] = None) -> None:
        self.api_key = os.getenv("OPENALEX_API_KEY", "").strip()
        self.client = client or httpx.AsyncClient(timeout=20, headers={"User-Agent": "NemoSearch/1.0 (+scholarly search)"})
        # Keyless limit is 10/s, keyed 30/s; leave headroom for other clients on the same network
        self.throttle = Throttle(per_second=8 if self.api_key else 4)
        self.cache = TTLCache(ttl_seconds=6 * 3600)

    def simulated_failure(self) -> bool:
        return self.name in {s.strip() for s in os.getenv("NEMOSEARCH_SIMULATE_FAILURE", "").lower().split(",")}

    async def search(self, query: str, k: int, record: QueryRecord) -> list[ScholarlyWork]:
        """Search works; fills `record` with what was sent and how it went. Raises ConnectorError."""
        sent = clean_query(query)
        record.query = sent
        params = {"search": sent, "per_page": max(1, min(k, 25)), "select": FIELDS}
        record.params = dict(params)  # the key is never recorded
        if not sent:
            raise ConnectorError("empty query", transient=False)
        if self.simulated_failure():
            record.attempts = 1
            raise ConnectorError("simulated failure (NEMOSEARCH_SIMULATE_FAILURE)")

        key = f"{sent.lower()}|{params['per_page']}"
        cached = self.cache.get(key)
        if cached is not None:
            works, retrieved_at = cached
            record.status, record.cached_from, record.results = "cached", retrieved_at, len(works)
            return list(works)

        if self.api_key:
            params["api_key"] = self.api_key
        response = await get_with_retry(self.client, API, params, self.throttle, record)
        retrieved_at = utc_now()
        try:
            items = response.json().get("results") or []
        except ValueError as e:
            raise ConnectorError(f"unreadable response: {e}", transient=False) from e
        works = [w for w in (to_work(item, sent, retrieved_at) for item in items) if w]
        self.cache.put(key, (works, retrieved_at))
        record.status, record.results = "ok", len(works)
        return works
