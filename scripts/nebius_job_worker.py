"""Asynchronous Background Research & Manuscript Worker for Nebius Serverless Jobs.

Designed to be invoked via `nebius ai job create` (or locally) for finite, asynchronous
deep-research workflows and automated LaTeX paper synthesis on Nebius Serverless AI.

Usage (inside Nebius Serverless Job container or local):
    python -m scripts.nebius_job_worker \
        --question "Dense vs. mixture-of-experts models for efficient inference" \
        --focus academic \
        --depth deep \
        --template neurips \
        --output-dir /app/data/job_outputs
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from backend.app.latex import create_latex_zip, generate_latex_paper  # noqa: E402
from backend.app.llm import LLM  # noqa: E402
from backend.app.pipeline import run_pipeline  # noqa: E402
from backend.app.scholarly import Scholarly  # noqa: E402
from backend.app.search import Search  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [nebius-job]: %(message)s")
log = logging.getLogger("nebius-job")


async def execute_job(
    question: str,
    focus: str,
    depth: str,
    template_id: str,
    output_dir: Path,
    owner_orcid: str | None = None,
) -> dict:
    t0 = time.perf_counter()
    llm = LLM()
    await llm.resolve_models()
    search = Search()
    scholarly = Scholarly()

    log.info("Starting Nebius Serverless Job | question=%r focus=%s depth=%s", question, focus, depth)

    report_chunks: list[str] = []
    reasoning_chunks: list[str] = []
    sources: list[dict] = []
    final_event: dict = {}

    async for ev in run_pipeline(question, depth, focus, llm, search, scholarly=scholarly):
        etype = ev.get("type")
        if etype == "stage":
            log.info("Stage [%s] -> %s (%s)", ev.get("agent"), ev.get("status"), ev.get("detail", ""))
        elif etype == "source":
            sources.append(ev["source"])
        elif etype == "delta":
            if ev.get("kind") == "reasoning":
                reasoning_chunks.append(ev.get("delta", ""))
            else:
                report_chunks.append(ev.get("delta", ""))
        elif etype == "done":
            final_event = ev

    report_text = final_event.get("report") or "".join(report_chunks)
    final_sources = final_event.get("sources") or sources

    log.info("Research synthesis complete (%d chars, %d sources). Generating LaTeX manuscript...", len(report_text), len(final_sources))
    paper = await generate_latex_paper(
        topic=question,
        report=report_text,
        sources=final_sources,
        template_id=template_id,
        llm=llm,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    slug = "".join(c if c.isalnum() else "_" for c in question.lower())[:40].strip("_") or "research_job"

    # Write Markdown report, JSON metadata, and compilable Overleaf ZIP bundle
    report_path = output_dir / f"{slug}_report.md"
    json_path = output_dir / f"{slug}_result.json"
    zip_path = output_dir / f"{slug}_paper_submission.zip"

    report_path.write_text(report_text, encoding="utf-8")
    zip_bytes = create_latex_zip(question, paper.get("latex", ""), paper.get("bibtex", ""))
    zip_path.write_bytes(zip_bytes)

    summary = {
        "ok": True,
        "question": question,
        "focus": focus,
        "depth": depth,
        "template_id": template_id,
        "elapsed_s": round(time.perf_counter() - t0, 2),
        "sources_count": len(final_sources),
        "report_chars": len(report_text),
        "latex_chars": len(paper.get("latex", "")),
        "stats": final_event.get("stats", {}),
        "artifacts": {
            "report_md": str(report_path),
            "result_json": str(json_path),
            "latex_zip": str(zip_path),
        },
    }
    json_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    # Optional: persist directly into the database if --owner-orcid is provided
    if owner_orcid:
        try:
            from backend.app.auth import Accounts
            from backend.app.blobs import open_blob_store
            from backend.app.config import settings
            from backend.app.db import create_db_engine, database_url, init_schema
            from backend.app.store import Store

            engine = create_db_engine(database_url(ROOT))
            init_schema(engine)
            blobs = open_blob_store(ROOT, settings.secret_key)
            accounts = Accounts(engine, blobs)
            store = Store(engine, blobs)
            user = accounts.ensure_user(owner_orcid, "Nebius Batch Researcher")
            saved = store.save_run(user.id, final_event | {"focus": focus, "depth": depth})
            summary["saved_report_id"] = saved.get("id")
            log.info("Saved batch run to database under report id=%s", saved.get("id"))
        except Exception as exc:  # noqa: BLE001
            log.warning("Skipping database save: %s", exc)

    log.info("Nebius Serverless Job finished in %.2fs -> %s", summary["elapsed_s"], zip_path)
    print(json.dumps(summary, indent=2))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="NemoSearch Asynchronous Worker for Nebius Serverless Jobs")
    parser.add_argument(
        "--question",
        default="Dense vs. mixture-of-experts models for efficient inference",
        help="Research question to investigate and synthesize into a paper",
    )
    parser.add_argument("--focus", default="academic", choices=["web", "academic", "finance", "news"])
    parser.add_argument("--depth", default="deep", choices=["fast", "deep"])
    parser.add_argument("--template", default="neurips", help="Paper Studio LaTeX template ID")
    parser.add_argument("--output-dir", default=str(ROOT / "data" / "job_outputs"), help="Directory for output artifacts")
    parser.add_argument("--owner-orcid", default=None, help="Optional ORCID iD to persist the completed run in DB")
    args = parser.parse_args()

    asyncio.run(
        execute_job(
            question=args.question,
            focus=args.focus,
            depth=args.depth,
            template_id=args.template,
            output_dir=Path(args.output_dir),
            owner_orcid=args.owner_orcid,
        )
    )


if __name__ == "__main__":
    main()

