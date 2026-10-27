"""arXiv preprint search (https://export.arxiv.org/api/query), following arXiv's API terms of use:

- No more than one request every three seconds, over a single connection at a time.
- Results change at most daily, so repeated queries are answered from cache.
- No key is needed. Retry only 429 and 5xx (and timeouts) with exponential backoff.

Search reads only the Atom metadata and abstract. When a run reads a paper in full, its PDF is fetched from
export.arxiv.org (the host arXiv designates for programmatic access) under the same throttle and connection.
Every arXiv record is a preprint, even when a journal version exists, so it is labelled that way.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import xml.etree.ElementTree as ET
from typing import Optional

import httpx

from .base import ConnectorError, QueryRecord, ScholarlyWork, Throttle, TTLCache, get_with_retry, utc_now
from .fulltext import FullText, fetch_pdf_text

log = logging.getLogger("nemosearch.connectors.arxiv")

API = "https://export.arxiv.org/api/query"
NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
MAX_AUTHORS = 25
MAX_TERMS = 5


def build_query(query: str) -> str:
    """Every keyword must appear (arXiv ORs bare words, which floods results); field syntax is stripped."""
    words = re.findall(r"[\w\-]+", query)
    terms = [w for w in words if w.upper() not in {"AND", "OR", "ANDNOT"}][:MAX_TERMS]
    return " AND ".join(f"all:{t}" for t in terms)


def _text(entry: ET.Element, path: str) -> str:
    el = entry.find(path, NS)
    return re.sub(r"\s+", " ", el.text).strip() if el is not None and el.text else ""


def to_work(entry: ET.Element, query: str, retrieved_at: str) -> Optional[ScholarlyWork]:
    source_id = _text(entry, "atom:id")          # e.g. http://arxiv.org/abs/2401.01234v2
    title = _text(entry, "atom:title")
    match = re.search(r"arxiv\.org/abs/(.+?)(v\d+)?$", source_id)
    if not title or not match:
        return None  # nothing we could cite honestly
    arxiv_id = match.group(1)
    published = _text(entry, "atom:published")
    category = entry.find("arxiv:primary_category", NS)
    pdf = next((link.get("href", "") for link in entry.findall("atom:link", NS) if link.get("title") == "pdf"), "")
    authors = [_text(a, "atom:name") for a in entry.findall("atom:author", NS)]
    return ScholarlyWork(
        connector="arxiv",
        source_id=source_id.replace("http://", "https://", 1),
        title=title,
        authors=[a for a in authors if a][:MAX_AUTHORS],
        year=int(published[:4]) if re.match(r"\d{4}", published) else None,
        venue="arXiv" + (f" ({category.get('term')})" if category is not None and category.get("term") else ""),
        # arXiv registers a DataCite DOI for every paper; it identifies this preprint, not a journal version
        doi=f"10.48550/arXiv.{arxiv_id}",
        url=f"https://arxiv.org/abs/{arxiv_id}",
        abstract=_text(entry, "atom:summary"),
        work_type="",  # arXiv has no type vocabulary; the status already says preprint
        status="preprint",
        retrieved_at=retrieved_at,
        query=query,
        is_open_access=True,
        oa_url=pdf.replace("http://", "https://", 1),
        # The exact version that was found, from arXiv's programmatic-access host
        pdf_url=f"https://export.arxiv.org/pdf/{arxiv_id}{match.group(2) or ''}",
    )


class ArxivConnector:
    name = "arxiv"
    label = "arXiv"
    # Each query costs at least three seconds, so only the first few distinct queries of a round are sent
    max_queries = 2

    def __init__(self, client: Optional[httpx.AsyncClient] = None) -> None:
        self.client = client or httpx.AsyncClient(
            timeout=20, follow_redirects=True, headers={"User-Agent": "NemoSearch/1.0 (+scholarly search)"}
        )
        self.throttle = Throttle(per_second=1 / 3)
        self.connection = asyncio.Lock()  # one request in flight at a time
        self.cache = TTLCache(ttl_seconds=12 * 3600)

    def simulated_failure(self) -> bool:
        return self.name in {s.strip() for s in os.getenv("NEMOSEARCH_SIMULATE_FAILURE", "").lower().split(",")}

    async def search(self, query: str, k: int, record: QueryRecord) -> list[ScholarlyWork]:
        """Search preprints; fills `record` with what was sent and how it went. Raises ConnectorError."""
        sent = build_query(query)
        record.query = sent
        params = {"search_query": sent, "start": 0, "max_results": max(1, min(k, 25)), "sortBy": "relevance"}
        record.params = dict(params)
        if not sent:
            raise ConnectorError("empty query", transient=False)
        if self.simulated_failure():
            record.attempts = 1
            raise ConnectorError("simulated failure (NEMOSEARCH_SIMULATE_FAILURE)")

        key = f"{sent.lower()}|{params['max_results']}"
        cached = self.cache.get(key)
        if cached is not None:
            works, retrieved_at = cached
            record.status, record.cached_from, record.results = "cached", retrieved_at, len(works)
            return list(works)

        async with self.connection:
            response = await get_with_retry(self.client, API, params, self.throttle, record)
        retrieved_at = utc_now()
        try:
            root = ET.fromstring(response.content)
        except ET.ParseError as e:
            raise ConnectorError(f"unreadable response: {e}", transient=False) from e
        entries = root.findall("atom:entry", NS)
        # A malformed query comes back as 200 with a single "Error" entry
        if len(entries) == 1 and "/api/errors" in _text(entries[0], "atom:id"):
            raise ConnectorError(f"query rejected: {_text(entries[0], 'atom:summary')[:160]}", transient=False)
        works = [w for w in (to_work(e, sent, retrieved_at) for e in entries) if w]
        self.cache.put(key, (works, retrieved_at))
        record.status, record.results = "ok", len(works)
        return works

    async def fulltext(self, pdf_url: str) -> FullText:
        """Text of an arXiv PDF, sharing the API's one-request-per-3s throttle and single connection."""
        if self.simulated_failure():
            raise ConnectorError("simulated failure (NEMOSEARCH_SIMULATE_FAILURE)")
        return await fetch_pdf_text(self.client, pdf_url, self.throttle, self.name, lock=self.connection)
