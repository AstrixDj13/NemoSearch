"""PaperPilot API server (FastAPI) with Perplexity-grade endpoints:
- Streaming research pipeline (with focus & depth parameters)
- Multi-turn Follow-up conversation streaming (/api/followup)
- 5-Slide Executive Outline generation (/api/slides)
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

from fastapi import FastAPI, Query  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from .llm import LLM  # noqa: E402
from .pipeline import answer_followup, generate_slides, run_pipeline  # noqa: E402
from .search import Search  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
FRONTEND = ROOT / "frontend"

llm = LLM()
search = Search()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await llm.resolve_models()
    logging.getLogger("paperpilot").info(
        "Mode=%s models=%s search=%s",
        "MOCK" if llm.mock else "LIVE",
        llm.models,
        search.provider,
    )
    yield


app = FastAPI(title="NemoSearch", lifespan=lifespan)


class FollowUpRequest(BaseModel):
    question: str
    prior_question: str
    prior_report: str
    sources: dict = {}


class SlidesRequest(BaseModel):
    topic: str
    report: str


@app.get("/api/health")
async def health():
    return {"ok": True, **llm.info(), "search_provider": search.provider}


@app.get("/api/research")
async def research(
    q: str = Query(..., min_length=3, max_length=500),
    depth: str = "quick",
    focus: str = "web",
):
    async def gen():
        try:
            async for ev in run_pipeline(q.strip(), depth, focus, llm, search):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001
            logging.exception("pipeline failed")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        yield "event: end\ndata: {}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/followup")
async def followup(req: FollowUpRequest):
    async def gen():
        try:
            async for ev in answer_followup(
                req.question, req.prior_question, req.prior_report, req.sources, llm, search
            ):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001
            logging.exception("followup failed")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        yield "event: end\ndata: {}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/slides")
async def slides_endpoint(req: SlidesRequest):
    try:
        data = await generate_slides(req.topic, req.report, llm)
        return JSONResponse(data)
    except Exception as e:  # noqa: BLE001
        logging.exception("slides generation failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
