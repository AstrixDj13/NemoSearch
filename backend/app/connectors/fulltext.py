"""Full text for open-access papers: download the PDF the provider lists as a free copy and extract its text.

Only openly hosted copies are fetched (every arXiv paper; OpenAlex works with an open-access PDF location).
No logins, cookies, proxies or mirrors are used, so a paywalled paper stays abstract-only. Anything that is not
a readable PDF (a login page, a captcha, a scan without a text layer) is reported as a failure, never guessed at.
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
from dataclasses import dataclass
from typing import Optional

import httpx

from .base import ConnectorError, QueryRecord, Throttle, get_with_retry, utc_now

log = logging.getLogger("nemosearch.connectors.fulltext")

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 60
# What the reader is given; long enough for a typical paper's body once references are dropped
MAX_CHARS = 40_000


@dataclass
class FullText:
    text: str
    url: str
    retrieved_at: str
    pages: int
    chars: int          # characters of body text extracted
    truncated: bool     # True when only the first MAX_CHARS characters were kept


def _strip_references(text: str) -> str:
    """Drops the reference list (and anything after it) when a References heading appears in the back half."""
    heads = list(re.finditer(r"\n\s*(references|bibliography|literature cited)\s*\n", text, re.I))
    if heads and heads[-1].start() > len(text) * 0.5:
        return text[: heads[-1].start()]
    return text


def _extract(data: bytes) -> tuple[str, int]:
    try:
        from pypdf import PdfReader
    except ImportError as e:  # pragma: no cover - listed in requirements.txt
        raise ConnectorError("the PDF reader (pypdf) is not installed", transient=False) from e
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = reader.pages[:MAX_PAGES]
        text = "\n".join((page.extract_text() or "") for page in pages)
    except Exception as e:  # noqa: BLE001 - malformed PDFs raise many different errors
        raise ConnectorError(f"the PDF could not be read ({type(e).__name__})", transient=False) from e
    return text, len(reader.pages)


async def fetch_pdf_text(
    client: httpx.AsyncClient, url: str, throttle: Throttle, label: str, lock: Optional[asyncio.Lock] = None,
) -> FullText:
    """Downloads one open-access PDF (with the connector's throttle and retries) and returns its text."""
    record = QueryRecord(connector=label, query=url, sent_at=utc_now())
    if lock:
        async with lock:
            response = await get_with_retry(client, url, {}, throttle, record, max_retries=2)
    else:
        response = await get_with_retry(client, url, {}, throttle, record, max_retries=2)
    data = response.content
    if len(data) > MAX_BYTES:
        raise ConnectorError(f"the PDF is larger than {MAX_BYTES // (1024 * 1024)} MB", transient=False)
    if not data.startswith(b"%PDF"):
        kind = response.headers.get("content-type", "unknown").split(";")[0]
        raise ConnectorError(f"the open-access link returned {kind}, not a PDF", transient=False)
    text, pages = await asyncio.to_thread(_extract, data)
    body = re.sub(r"[ \t]+", " ", _strip_references(text))
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    if len(body) < 1500:
        raise ConnectorError("the PDF has no usable text layer", transient=False)
    return FullText(
        text=body[:MAX_CHARS], url=str(response.url), retrieved_at=utc_now(), pages=pages,
        chars=len(body), truncated=len(body) > MAX_CHARS,
    )
