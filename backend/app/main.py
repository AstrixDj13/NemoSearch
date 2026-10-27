"""NemoSearch API server (FastAPI) with Perplexity-grade endpoints:
- Streaming research pipeline (with focus & depth parameters)
- Multi-turn Follow-up conversation streaming (/api/followup)
- 5-Slide Executive Outline generation (/api/slides)
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional
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
    logging.getLogger("nemosearch").info(
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
    focus: str = "web"
    models: dict = {}
    search_provider: Optional[str] = None


class SlidesRequest(BaseModel):
    topic: str
    report: str
    models: dict = {}


@app.get("/api/health")
async def health():
    return {"ok": True, **llm.info(), "search_provider": search.provider}


@app.get("/api/models")
async def models():
    """Recommended routing per pipeline step plus everything the user may switch to."""
    return {
        "mock": llm.mock,
        "defaults": {**llm.step_models(), "scout": search.provider},
        "models": llm.chat_models(),
        "search_providers": search.providers(),
    }


@app.get("/api/research")
async def research(
    q: str = Query(..., min_length=3, max_length=500),
    depth: str = "quick",
    focus: str = "web",
    planner_model: Optional[str] = None,
    reader_model: Optional[str] = None,
    critic_model: Optional[str] = None,
    writer_model: Optional[str] = None,
    search_provider: Optional[str] = None,
):
    overrides = {"planner": planner_model, "reader": reader_model, "critic": critic_model, "writer": writer_model}

    async def gen():
        try:
            async for ev in run_pipeline(q.strip(), depth, focus, llm, search, overrides, search_provider):
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
                req.question, req.prior_question, req.prior_report, req.sources, llm, search, req.focus,
                req.models, req.search_provider,
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
        data = await generate_slides(req.topic, req.report, llm, req.models)
        return JSONResponse(data)
    except Exception as e:  # noqa: BLE001
        logging.exception("slides generation failed")
        return JSONResponse({"error": str(e)}, status_code=500)


# ------------------------------------------------ Paper Studio Endpoints
from fastapi import Response  # noqa: E402
from .latex import (  # noqa: E402
    create_latex_zip,
    generate_latex_paper,
    get_all_templates,
    install_custom_template,
    refine_latex_paper,
)


class PaperGenerateRequest(BaseModel):
    topic: str
    report: str
    sources: Any = []
    template_id: str = "neurips"
    custom_preamble: str = ""


class PaperRefineRequest(BaseModel):
    topic: str
    current_latex: str
    instruction: str
    sources: Any = []


class InstallTemplateRequest(BaseModel):
    name: str
    doc_class: str = "\\documentclass{article}"
    preamble: str = ""
    venue: str = ""


class ZipDownloadRequest(BaseModel):
    topic: str
    latex: str
    bibtex: str


PaperGenerateRequest.model_rebuild()
PaperRefineRequest.model_rebuild()
InstallTemplateRequest.model_rebuild()
ZipDownloadRequest.model_rebuild()


@app.get("/api/paper/templates")
async def paper_templates():
    return {"templates": get_all_templates()}


@app.post("/api/paper/install_template")
async def install_template(req: InstallTemplateRequest):
    tpl = install_custom_template(req.name, req.doc_class, req.preamble, req.venue)
    return {"ok": True, "template": tpl}


@app.post("/api/paper/generate")
async def generate_paper(req: PaperGenerateRequest):
    try:
        res = await generate_latex_paper(
            req.topic, req.report, req.sources, req.template_id, llm, req.custom_preamble
        )
        return JSONResponse(res)
    except Exception as e:  # noqa: BLE001
        logging.exception("paper generation failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/paper/refine")
async def refine_paper_endpoint(req: PaperRefineRequest):
    try:
        res = await refine_latex_paper(
            req.topic, req.current_latex, req.instruction, req.sources, llm
        )
        return JSONResponse(res)
    except Exception as e:  # noqa: BLE001
        logging.exception("paper refinement failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/paper/download_zip")
async def download_paper_zip(req: ZipDownloadRequest):
    try:
        zip_bytes = create_latex_zip(req.topic, req.latex, req.bibtex)
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="paper_submission.zip"',
                "Cache-Control": "no-cache",
            },
        )
    except Exception as e:  # noqa: BLE001
        logging.exception("zip creation failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")

