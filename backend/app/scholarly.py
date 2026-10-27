"""Scholarly search for academic research runs: intent detection, connector fan-out and a coverage log.

Retrieved works become pipeline sources that carry their provenance (connector, original identifier,
retrieval time, the exact query sent). Nothing is synthesized when a connector fails; the failure is
recorded so the run can report that scholarly coverage is incomplete.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

from .connectors import CONNECTORS, ConnectorError, QueryRecord, ScholarlyWork, utc_now

log = logging.getLogger("nemosearch.scholarly")

# Open-access papers read in full per research round; each PDF costs a download plus a long reader prompt
FULLTEXT_PER_ROUND = 6

# Phrases that signal the user wants the research literature, not general web pages
_ACADEMIC = [
    r"\bpapers?\b", r"\bpeer[- ]reviewed\b", r"\bliterature\b", r"\bsystematic review\b", r"\bmeta[- ]analys[ie]s\b",
    r"\bjournals?\b", r"\barxiv\b", r"\bpreprints?\b", r"\bpublications?\b", r"\bcitations?\b", r"\bdoi\b",
    r"\bthesis\b", r"\bdissertation\b", r"\bscholarly\b", r"\bacademic\b", r"\bempirical\b",
    r"\brandomi[sz]ed\b", r"\bclinical trials?\b", r"\bcohort stud(y|ies)\b", r"\bstate of the art\b", r"\bsota\b",
    r"\bresearch (on|into|about)\b", r"\bstudies (on|of|about)\b", r"\bevidence base\b",
]
_ACADEMIC_RE = re.compile("|".join(_ACADEMIC), re.I)

_STOP = set("""a an the of in on for to and or vs versus how what why when which who whose is are was were be been do
does did can could should would will with by from as at into about over under between than that this these those it
its their there latest recent new paper papers study studies research literature review evidence peer reviewed
academic scholarly publications published find show give list summarize summarise explain say says said tell
known current peer-reviewed peer developments statistics outlook future""".split())


def academic_intent(question: str, focus: str = "web") -> tuple[bool, str]:
    """Deterministic, explainable check: the Academic focus, or academic wording in the question."""
    if focus == "academic":
        return True, "Academic focus was selected"
    match = _ACADEMIC_RE.search(question)
    if match:
        return True, f"The question asks about “{match.group(0).lower()}”"
    return False, ""


def keyword_query(query: str, n: int = 6) -> str:
    """OpenAlex ANDs every word after stemming, so long natural-language queries match little; keep the content words."""
    words = [w.strip("?,.:;()[]\"'") for w in query.split()]
    kept = [w for w in words if w and w.lower() not in _STOP and not re.fullmatch(r"(19|20)\d\d", w)]
    return " ".join(kept[:n]) or query


def work_to_source(work: ScholarlyWork) -> dict:
    """A pipeline source. `content` starts as the abstract (papers without one are marked metadata-only) and is
    replaced by the paper's text if `Scholarly.read_fulltext` retrieves an open-access copy."""
    return {
        "kind": "paper",
        "title": work.title,
        "url": work.url,
        "content": work.abstract,
        "domain": work.venue or CONNECTORS[work.connector].label,
        "provider": work.connector,
        "focus": "academic",
        "query": work.query,
        "access": "abstract" if work.abstract else "metadata",
        "retrieved_at": work.retrieved_at,
        "paper": {
            "connector": work.connector,
            "connector_label": CONNECTORS[work.connector].label,
            "source_id": work.source_id,
            "authors": work.authors,
            "year": work.year,
            "venue": work.venue,
            "doi": work.doi,
            "work_type": work.work_type,
            "status": work.status,
            "is_open_access": work.is_open_access,
            "oa_url": work.oa_url,
            "pdf_url": work.pdf_url,
        },
    }


def _title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]", "", title.lower())


def dedupe(works) -> list[ScholarlyWork]:
    """One entry per work across connectors (OpenAlex also indexes arXiv), matched by DOI or exact title.

    The first copy wins its position; a later copy replaces it only when it has an abstract and the first doesn't.
    """
    kept: list[ScholarlyWork] = []
    index: dict[str, int] = {}
    for w in works:
        keys = [k for k in (w.doi.lower() if w.doi else "", _title_key(w.title)) if k]
        hit = next((index[k] for k in keys if k in index), None)
        if hit is None:
            index.update({k: len(kept) for k in keys})
            kept.append(w)
        else:
            if w.abstract and not kept[hit].abstract:
                kept[hit] = w
            index.update({k: hit for k in keys})
    return kept


class Scholarly:
    def __init__(self, names: Optional[list[str]] = None) -> None:
        self.connectors = [CONNECTORS[n]() for n in (names or ["openalex", "arxiv"])]
        self.by_name = {c.name: c for c in self.connectors}

    def labels(self) -> list[str]:
        return [c.label for c in self.connectors]

    async def search(self, queries: list[str], k: int) -> tuple[list[dict], list[QueryRecord]]:
        """Runs every query on every connector. Failures are recorded, never raised or papered over."""
        jobs, records = [], []
        # Planner queries often reduce to the same keywords; send each distinct query once
        distinct = list(dict.fromkeys(keyword_query(q) for q in queries))
        for connector in self.connectors:
            # Slow, strictly rate-limited providers (arXiv) take only the first few queries
            for q in distinct[: getattr(connector, "max_queries", None)]:
                record = QueryRecord(connector=connector.name, query=q, sent_at=utc_now())
                records.append(record)
                jobs.append(self._one(connector, q, k, record))
        batches = await asyncio.gather(*jobs)
        return [work_to_source(w) for w in dedupe(w for batch in batches for w in batch)], records

    async def read_fulltext(self, src: dict) -> None:
        """Swaps a paper's abstract for its open-access full text, or records in `src["fulltext"]` why it couldn't."""
        paper = src.get("paper") or {}
        pdf_url = paper.get("pdf_url") or ""
        connector = self.by_name.get(paper.get("connector", ""))
        if not pdf_url or not connector:
            src["fulltext"] = {"status": "unavailable", "error": "no open-access copy is listed"}
            return
        try:
            text = await connector.fulltext(pdf_url)
        except ConnectorError as e:
            src["fulltext"] = {"status": "failed", "url": pdf_url, "error": str(e)}
            log.warning("full text for %r failed: %s", src.get("title"), e)
            return
        except Exception as e:  # noqa: BLE001 - a bug here must leave the paper abstract-only, not break the run
            log.exception("full text for %r crashed", src.get("title"))
            src["fulltext"] = {"status": "failed", "url": pdf_url, "error": f"unexpected error: {type(e).__name__}"}
            return
        src["content"] = text.text
        src["access"] = "fulltext"
        src["fulltext"] = {
            "status": "ok", "url": text.url, "retrieved_at": text.retrieved_at, "pages": text.pages,
            "chars": text.chars, "truncated": text.truncated,
        }

    @staticmethod
    async def _one(connector, query: str, k: int, record: QueryRecord) -> list[ScholarlyWork]:
        try:
            return await connector.search(query, k, record)
        except ConnectorError as e:
            record.status, record.error = "failed", str(e)
        except Exception as e:  # noqa: BLE001 - an unexpected bug must still count as missing coverage
            log.exception("%s connector crashed", connector.name)
            record.status, record.error = "failed", f"unexpected error: {type(e).__name__}"
        log.warning("%s query %r failed: %s", connector.name, record.query, record.error)
        return []


def coverage_summary(records: list[dict], labels: dict[str, str]) -> dict:
    """Status of scholarly coverage across all records of a run."""
    failed = [r for r in records if r["status"] == "failed"]
    if not records:
        status = "skipped"
    elif not failed:
        status = "complete"
    elif len(failed) == len(records):
        status = "failed"
    else:
        status = "partial"
    message = ""
    if failed:
        names = ", ".join(sorted({labels.get(r["connector"], r["connector"]) for r in failed}))
        reasons = "; ".join(sorted({r["error"] for r in failed if r["error"]}))
        message = (
            f"Scholarly coverage is incomplete: {names} failed for {len(failed)} of {len(records)} "
            f"{'query' if len(records) == 1 else 'queries'} ({reasons}). "
            "Web results were kept; no papers were added for the failed queries."
        )
    return {"status": status, "failed": len(failed), "total": len(records), "message": message}
