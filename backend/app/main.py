"""NemoSearch API server (FastAPI) with Perplexity-grade endpoints:
- Streaming research pipeline (with focus & depth parameters); finished runs are saved server-side
- Multi-turn Follow-up conversation streaming (/api/followup)
- 5-Slide Executive Outline generation (/api/slides)
- Projects and research history persisted in SQLite (/api/projects, /api/reports, ...)
"""
from __future__ import annotations

import json
import logging
import time
from typing import Optional
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

from fastapi import FastAPI, HTTPException, Query, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from .llm import LLM  # noqa: E402
from .pipeline import answer_followup, generate_slides, run_pipeline  # noqa: E402
from .scholarly import Scholarly  # noqa: E402
from .search import Search  # noqa: E402
from .store import MAX_ATTACHMENT_BYTES, NotFound, open_store  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
FRONTEND = ROOT / "frontend"

llm = LLM()
search = Search()
scholarly = Scholarly()
store = open_store(ROOT)

FOCUS_LABELS = {"web": "All web", "academic": "Academic", "finance": "Finance & SEC", "news": "Recent news"}


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
    # Earlier turns of this thread, oldest first: [{"question": ..., "answer": ...}]
    history: list = []
    # The saved report this thread belongs to; answered turns are stored with it
    report_id: Optional[str] = None


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
        "presets": {name: {**models, "scout": search.provider} for name, models in llm.presets().items()},
        "models": llm.chat_models(),
        "search_providers": search.providers(),
        "scholarly_connectors": scholarly.labels(),
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
    project_id: Optional[str] = None,
    title: Optional[str] = Query(None, max_length=200),
):
    overrides = {"planner": planner_model, "reader": reader_model, "critic": critic_model, "writer": writer_model}
    project = store.resolve_project(project_id)

    async def gen():
        report, reasoning, models = "", "", {}
        try:
            if project_id and project is None:
                notice = "That project no longer exists, so this research is saved to Unassigned."
                yield f"data: {json.dumps({'type': 'notice', 'message': notice})}\n\n"
            async for ev in run_pipeline(q.strip(), depth, focus, llm, search, overrides, search_provider, scholarly):
                kind = ev.get("type")
                if kind == "report":
                    report += ev["delta"]
                elif kind == "think":
                    reasoning += ev["delta"]
                elif kind == "init":
                    models = {**ev.get("models", {}), "scout": ev.get("search_provider")}
                yield f"data: {json.dumps(ev)}\n\n"
                if kind == "done":
                    # Persist the finished run on the server, inside its project (or Unassigned)
                    try:
                        saved = store.save_report({
                            "title": title or q.strip(), "question": q.strip(), "mode": FOCUS_LABELS.get(focus, "All web"),
                            "sources": ev.get("n_sources", 0), "reportText": report, "reasoningTrace": reasoning,
                            "sourcesData": [
                                {**s, "authors": ", ".join(s["paper"]["authors"]) if s.get("paper") else s.get("domain", ""),
                                 "relevance": round((s.get("relevance") or 0) * 10)}
                                for s in ev.get("sources", {}).values()
                            ],
                            "models": models, "coverage": ev.get("coverage") or {}, "createdAt": int(time.time() * 1000),
                        }, project)
                        yield f"data: {json.dumps({'type': 'saved', 'report': {k: v for k, v in saved.items() if k not in ('reportText', 'reasoningTrace', 'sourcesData')}})}\n\n"
                    except Exception as e:  # noqa: BLE001
                        logging.exception("saving report failed")
                        yield f"data: {json.dumps({'type': 'error', 'message': f'The report finished but could not be saved: {e}'})}\n\n"
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
        answer, new_sources = "", []
        try:
            async for ev in answer_followup(
                req.question, req.prior_question, req.prior_report, req.sources, llm, search, req.focus,
                req.models, req.search_provider, req.history,
            ):
                kind = ev.get("type")
                if kind == "followup_delta" and ev.get("kind") == "text":
                    answer += ev["delta"]
                elif kind == "source":
                    new_sources.append({**ev["source"], "authors": ev["source"].get("domain", ""), "relevance": 0})
                yield f"data: {json.dumps(ev)}\n\n"
                if kind == "followup_done" and req.report_id and answer.strip():
                    # Keep the thread with its report so it survives reloads
                    try:
                        store.add_followup(req.report_id, {
                            "question": req.question, "answer": answer, "createdAt": int(time.time() * 1000),
                        }, new_sources)
                        yield f"data: {json.dumps({'type': 'followup_saved'})}\n\n"
                    except NotFound:
                        pass
                    except Exception as e:  # noqa: BLE001
                        logging.exception("saving follow-up failed")
                        yield f"data: {json.dumps({'type': 'error', 'message': f'The answer could not be saved: {e}'})}\n\n"
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


# ---------------------------------------------------------------- projects & history
class ProjectCreate(BaseModel):
    name: str
    description: str = ""


class ProjectPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    notes: Optional[str] = None
    archived: Optional[bool] = None


class ReportPatch(BaseModel):
    title: Optional[str] = None
    archived: Optional[bool] = None
    projectId: Optional[str] = None
    moveProject: bool = False


class SourceCreate(BaseModel):
    projectId: Optional[str] = None
    reportId: Optional[str] = None
    source: dict


class ExportCreate(BaseModel):
    projectId: Optional[str] = None
    reportId: Optional[str] = None
    kind: str
    filename: str
    content: Optional[str] = None


def _not_found(e: NotFound):
    raise HTTPException(status_code=404, detail=f"Not found: {e}")


@app.get("/api/storage")
async def storage_info():
    """Where history lives, so the UI can describe it accurately (a server-side SQLite file, not the browser)."""
    return {"kind": "server", "engine": "sqlite"}


@app.get("/api/projects")
async def projects_list():
    return store.list_projects()


@app.post("/api/projects", status_code=201)
async def projects_create(body: ProjectCreate):
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="A project needs a name.")
    return store.create_project(body.name, body.description)


@app.get("/api/projects/{project_id}")
async def projects_get(project_id: str):
    try:
        return store.get_project(project_id)
    except NotFound as e:
        _not_found(e)


@app.patch("/api/projects/{project_id}")
async def projects_update(project_id: str, body: ProjectPatch):
    if body.name is not None and not body.name.strip():
        raise HTTPException(status_code=422, detail="A project needs a name.")
    try:
        return store.update_project(project_id, body.model_dump(exclude_none=True))
    except NotFound as e:
        _not_found(e)


@app.delete("/api/projects/{project_id}")
async def projects_delete(project_id: str, reports: str = Query("unassign", pattern="^(unassign|delete)$")):
    try:
        return store.delete_project(project_id, delete_reports=reports == "delete")
    except NotFound as e:
        _not_found(e)


@app.get("/api/reports")
async def reports_list(project: str = "all"):
    return store.list_reports(project)


@app.post("/api/reports/import")
async def reports_import(reports: list[dict]):
    return {"imported": store.import_reports(reports)}


@app.get("/api/reports/{report_id}")
async def reports_get(report_id: str):
    try:
        return store.get_report(report_id)
    except NotFound as e:
        _not_found(e)


@app.patch("/api/reports/{report_id}")
async def reports_update(report_id: str, body: ReportPatch):
    patch = body.model_dump(exclude_none=True)
    if body.moveProject:
        patch["projectId"] = body.projectId  # None moves the report to Unassigned
    patch.pop("moveProject", None)
    try:
        return store.update_report(report_id, patch)
    except NotFound as e:
        _not_found(e)


@app.post("/api/reports/{report_id}/duplicate", status_code=201)
async def reports_duplicate(report_id: str):
    try:
        return store.duplicate_report(report_id)
    except NotFound as e:
        _not_found(e)


@app.delete("/api/reports/{report_id}")
async def reports_delete(report_id: str):
    try:
        store.set_report_deleted(report_id, True)
        return {"ok": True}
    except NotFound as e:
        _not_found(e)


@app.post("/api/reports/{report_id}/restore")
async def reports_restore(report_id: str):
    try:
        store.set_report_deleted(report_id, False)
        return {"ok": True}
    except NotFound as e:
        _not_found(e)


@app.get("/api/sources")
async def sources_list(project: str = "unassigned"):
    return store.list_sources(project)


@app.post("/api/sources", status_code=201)
async def sources_save(body: SourceCreate):
    if not body.source.get("url"):
        raise HTTPException(status_code=422, detail="A saved source needs a URL.")
    return store.save_source(body.projectId, body.reportId, body.source)


@app.delete("/api/sources/{source_id}")
async def sources_delete(source_id: str):
    try:
        store.delete_source(source_id)
        return {"ok": True}
    except NotFound as e:
        _not_found(e)


@app.post("/api/projects/{project_id}/attachments", status_code=201)
async def attachments_upload(project_id: str, request: Request):
    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail="The file is empty.")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Files can be up to 15 MB.")
    filename = request.headers.get("x-filename", "attachment")
    try:
        from urllib.parse import unquote

        return store.add_attachment(project_id, unquote(filename), request.headers.get("content-type", "application/octet-stream"), data)
    except NotFound as e:
        _not_found(e)


@app.get("/api/attachments/{attachment_id}")
async def attachments_download(attachment_id: str):
    try:
        path, filename, content_type = store.attachment_file(attachment_id)
    except NotFound as e:
        _not_found(e)
    return FileResponse(path, media_type=content_type, filename=filename)


@app.delete("/api/attachments/{attachment_id}")
async def attachments_delete(attachment_id: str):
    try:
        store.delete_attachment(attachment_id)
        return {"ok": True}
    except NotFound as e:
        _not_found(e)


@app.post("/api/exports", status_code=201)
async def exports_record(body: ExportCreate):
    return store.add_export(body.projectId, body.reportId, body.kind, body.filename, body.content)


@app.get("/api/exports/{export_id}/download")
async def exports_download(export_id: str):
    try:
        filename, content = store.export_content(export_id)
    except NotFound as e:
        _not_found(e)
    return Response(content, media_type="text/markdown", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
