"""NemoSearch API server (FastAPI) with Perplexity-grade endpoints:
- Streaming research pipeline (with focus & depth parameters); finished runs are saved server-side
- Multi-turn Follow-up conversation streaming (/api/followup)
- 5-Slide Executive Outline generation (/api/slides)
- Accounts (ORCID sign-in), private projects and research history (/api/projects, /api/reports, ...)
- NemoSearch Network: publishing, discovery and collaboration requests (/api/network/...)

Every endpoint that reads or writes someone's data needs a signed-in account, and the data layer checks that
account on each request (store.py, network.py); nothing relies on the interface hiding things.
"""
from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Optional
from urllib.parse import unquote, urlparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

import sqlalchemy as sa  # noqa: E402
from fastapi import Depends, FastAPI, Query, Request  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import auth as auth_module  # noqa: E402
from . import network as network_module  # noqa: E402
from .auth import Accounts, Unauthorized  # noqa: E402
from .blobs import LocalBlobStore, content_disposition, open_blob_store  # noqa: E402
from .config import settings  # noqa: E402
from .db import create_db_engine, database_url, init_schema  # noqa: E402
from .errors import Conflict, Forbidden, Invalid, NotFound, RateLimited, consume  # noqa: E402
from .llm import LLM  # noqa: E402
from .network import Network  # noqa: E402
from .pipeline import answer_followup, generate_slides, run_pipeline  # noqa: E402
from .scholarly import Scholarly  # noqa: E402
from .search import Search  # noqa: E402
from .store import MAX_ATTACHMENT_BYTES, Store  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
FRONTEND = ROOT / "frontend"

_problems = settings.problems()
if _problems:
    raise RuntimeError("NemoSearch will not start with an unsafe configuration:\n- " + "\n- ".join(_problems))

llm = LLM()
search = Search()
scholarly = Scholarly()
engine = create_db_engine(database_url(ROOT))
init_schema(engine)
blobs = open_blob_store(ROOT, settings.secret_key)
store = Store(engine, blobs)
accounts = Accounts(engine, blobs)
network = Network(engine, blobs, store)

FOCUS_LABELS = {"web": "All web", "academic": "Academic", "finance": "Finance & SEC", "news": "Recent news"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    await llm.resolve_models()
    logging.getLogger("nemosearch").info(
        "Mode=%s models=%s search=%s database=%s",
        "MOCK" if llm.mock else "LIVE",
        llm.models,
        search.provider,
        engine.dialect.name,
    )
    yield


app = FastAPI(title="NemoSearch", lifespan=lifespan)

# ---------------------------------------------------------------- errors, cross-site protection, headers
for exc, status in ((Unauthorized, 401), (Forbidden, 403), (NotFound, 404), (Conflict, 409), (Invalid, 422), (RateLimited, 429)):
    def _handler(_request: Request, e: Exception, status: int = status) -> JSONResponse:
        detail = {401: "Sign in to continue.", 404: "Not found."}.get(status) or str(e)
        return JSONResponse({"detail": detail}, status_code=status)

    app.add_exception_handler(exc, _handler)

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@app.middleware("http")
async def protect(request: Request, call_next):
    # Session cookies are SameSite=Lax, and on top of that a state-changing request must come from this site.
    # Browsers always send Origin on cross-site POST/PATCH/DELETE, so a page elsewhere cannot act as the user.
    if request.method not in SAFE_METHODS:
        origin = request.headers.get("origin")
        if origin and origin not in settings.allowed_origins:
            host = request.headers.get("host", "")
            if urlparse(origin).netloc != host:
                return JSONResponse({"detail": "Cross-site request refused."}, status_code=403)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if settings.secure_cookies:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


CurrentUser = Annotated[sa.Row, Depends(accounts.require_user)]

app.include_router(auth_module.build_router(accounts))
app.include_router(network_module.build_router(network, accounts))


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


def _limit(user_id: str, kind: str, per_day: int, what: str) -> None:
    with engine.begin() as conn:
        consume(conn, user_id, kind, per_day, what)


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
def research(
    user: CurrentUser,
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
    # Lets the agents read the project's paper, description and notes; off answers the question on its own
    use_context: bool = True,
):
    _limit(user.id, "research", settings.limit_research_per_day, "research runs")
    overrides = {"planner": planner_model, "reader": reader_model, "critic": critic_model, "writer": writer_model}
    project = store.accessible_project(user.id, project_id)
    context = store.project_context(user.id, project) if project and use_context else None

    async def gen():
        report, reasoning, models = "", "", {}
        try:
            if project_id and project is None:
                notice = "That project no longer exists, so this research is saved to Unassigned."
                yield f"data: {json.dumps({'type': 'notice', 'message': notice})}\n\n"
            async for ev in run_pipeline(q.strip(), depth, focus, llm, search, overrides, search_provider, scholarly, context):
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
                        saved = await run_in_threadpool(store.save_report, user.id, {
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
def followup(user: CurrentUser, req: FollowUpRequest):
    if req.report_id and not store.can_read_report(user.id, req.report_id):
        raise NotFound(req.report_id)
    _limit(user.id, "followup", settings.limit_research_per_day * 5, "follow-up questions")

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
                        await run_in_threadpool(store.add_followup, user.id, req.report_id, {
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
async def slides_endpoint(req: SlidesRequest, user: CurrentUser):
    await run_in_threadpool(_limit, user.id, "slides", settings.limit_research_per_day, "slide outlines")
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


class MemberAdd(BaseModel):
    orcid: str


class MessageCreate(BaseModel):
    body: str


@app.get("/api/trending-topics")
async def trending_topics():
    """Most-published research topics of the last 30 days (OpenAlex), for the home page's example question.

    On failure the list is empty, so the page shows a generic prompt instead of made-up topics.
    """
    try:
        return await scholarly.by_name["openalex"].trending_topics()
    except Exception as e:  # noqa: BLE001
        logging.warning("trending topics unavailable: %s", e)
        return {"topics": [], "error": str(e), "source": "OpenAlex"}


@app.get("/api/storage")
async def storage_info():
    """Where history lives, so the UI can describe it accurately (the server's database, not the browser)."""
    return {"kind": "server", "engine": engine.dialect.name}


@app.get("/api/projects")
def projects_list(user: CurrentUser):
    return store.list_projects(user.id)


@app.post("/api/projects", status_code=201)
def projects_create(user: CurrentUser, body: ProjectCreate):
    if not body.name.strip():
        raise Invalid("A project needs a name.")
    return store.create_project(user.id, body.name, body.description)


@app.get("/api/projects/{project_id}")
def projects_get(user: CurrentUser, project_id: str):
    return store.get_project(user.id, project_id)


@app.patch("/api/projects/{project_id}")
def projects_update(user: CurrentUser, project_id: str, body: ProjectPatch):
    if body.name is not None and not body.name.strip():
        raise Invalid("A project needs a name.")
    return store.update_project(user.id, project_id, body.model_dump(exclude_none=True))


@app.delete("/api/projects/{project_id}")
def projects_delete(user: CurrentUser, project_id: str, reports: str = Query("unassign", pattern="^(unassign|delete)$")):
    return store.delete_project(user.id, project_id, delete_reports=reports == "delete")


@app.post("/api/projects/{project_id}/members")
def projects_member_add(user: CurrentUser, project_id: str, body: MemberAdd):
    return store.add_member(user.id, project_id, auth_module.normalize_orcid(body.orcid))


@app.delete("/api/projects/{project_id}/members/{member_id}")
def projects_member_remove(user: CurrentUser, project_id: str, member_id: str):
    store.remove_member(user.id, project_id, member_id)
    return {"ok": True}


@app.get("/api/projects/{project_id}/messages")
def projects_messages(user: CurrentUser, project_id: str, after: Optional[int] = None):
    return store.list_messages(user.id, project_id, after)


@app.post("/api/projects/{project_id}/messages", status_code=201)
def projects_message_post(user: CurrentUser, project_id: str, body: MessageCreate):
    return store.post_message(user.id, project_id, body.body)


@app.get("/api/reports")
def reports_list(user: CurrentUser, project: str = "all"):
    return store.list_reports(user.id, project)


@app.post("/api/reports/import")
def reports_import(user: CurrentUser, reports: list[dict]):
    return {"imported": store.import_reports(user.id, reports)}


@app.get("/api/reports/{report_id}")
def reports_get(user: CurrentUser, report_id: str):
    return store.get_report(user.id, report_id)


@app.patch("/api/reports/{report_id}")
def reports_update(user: CurrentUser, report_id: str, body: ReportPatch):
    patch = body.model_dump(exclude_none=True)
    if body.moveProject:
        patch["projectId"] = body.projectId  # None moves the report to Unassigned
    patch.pop("moveProject", None)
    return store.update_report(user.id, report_id, patch)


@app.post("/api/reports/{report_id}/duplicate", status_code=201)
def reports_duplicate(user: CurrentUser, report_id: str):
    return store.duplicate_report(user.id, report_id)


@app.delete("/api/reports/{report_id}")
def reports_delete(user: CurrentUser, report_id: str):
    store.set_report_deleted(user.id, report_id, True)
    return {"ok": True}


@app.post("/api/reports/{report_id}/restore")
def reports_restore(user: CurrentUser, report_id: str):
    store.set_report_deleted(user.id, report_id, False)
    return {"ok": True}


@app.get("/api/sources")
def sources_list(user: CurrentUser, project: str = "unassigned"):
    return store.list_sources(user.id, project)


@app.post("/api/sources", status_code=201)
def sources_save(user: CurrentUser, body: SourceCreate):
    if not body.source.get("url"):
        raise Invalid("A saved source needs a URL.")
    return store.save_source(user.id, body.projectId, body.reportId, body.source)


@app.delete("/api/sources/{source_id}")
def sources_delete(user: CurrentUser, source_id: str):
    store.delete_source(user.id, source_id)
    return {"ok": True}


@app.post("/api/projects/{project_id}/attachments", status_code=201)
async def attachments_upload(project_id: str, request: Request):
    user = await run_in_threadpool(accounts.require_user, request)
    if int(request.headers.get("content-length") or 0) > MAX_ATTACHMENT_BYTES:
        raise Invalid("Files can be up to 15 MB.")
    data = await request.body()
    if not data:
        raise Invalid("The file is empty.")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise Invalid("Files can be up to 15 MB.")
    filename = unquote(request.headers.get("x-filename", "attachment"))
    return await run_in_threadpool(store.add_attachment, user.id, project_id, filename,
                                   request.headers.get("content-type", "application/octet-stream"), data)


@app.get("/api/attachments/{attachment_id}")
def attachments_download(user: CurrentUser, attachment_id: str):
    return RedirectResponse(store.attachment_link(user.id, attachment_id), status_code=303)


@app.delete("/api/attachments/{attachment_id}")
def attachments_delete(user: CurrentUser, attachment_id: str):
    store.delete_attachment(user.id, attachment_id)
    return {"ok": True}


@app.get("/api/files/{token}")
def local_file(token: str):
    """Serves a file from local storage through a signed, expiring link (development storage only)."""
    if not isinstance(blobs, LocalBlobStore):
        raise NotFound(token)
    found = blobs.open_link(token)
    if found is None:
        raise NotFound(token)
    path, filename, content_type = found
    return FileResponse(path, media_type=content_type, headers={"Content-Disposition": content_disposition(filename)})


@app.post("/api/exports", status_code=201)
def exports_record(user: CurrentUser, body: ExportCreate):
    return store.add_export(user.id, body.projectId, body.reportId, body.kind, body.filename, body.content)


@app.get("/api/exports/{export_id}/download")
def exports_download(user: CurrentUser, export_id: str):
    filename, content = store.export_content(user.id, export_id)
    return Response(content, media_type="text/markdown", headers={"Content-Disposition": content_disposition(filename)})


# ------------------------------------------------ Paper Studio Endpoints
from .latex import (  # noqa: E402
    create_latex_zip,
    generate_latex_paper,
    get_all_templates,
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
    report: str = ""
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
def paper_templates(user: CurrentUser):
    return {"templates": get_all_templates(store.list_templates(user.id))}


@app.post("/api/paper/install_template")
def install_template(user: CurrentUser, req: InstallTemplateRequest):
    tpl = store.install_template(user.id, req.name, req.doc_class, req.preamble, req.venue)
    return {"ok": True, "template": tpl}


@app.post("/api/paper/generate")
async def generate_paper(req: PaperGenerateRequest, user: CurrentUser):
    await run_in_threadpool(_limit, user.id, "paper", settings.limit_research_per_day, "paper drafts")
    custom = await run_in_threadpool(store.list_templates, user.id)
    try:
        res = await generate_latex_paper(
            req.topic, req.report, req.sources, req.template_id, llm, req.custom_preamble, custom
        )
        return JSONResponse(res)
    except Exception as e:  # noqa: BLE001
        logging.exception("paper generation failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/paper/refine")
async def refine_paper_endpoint(req: PaperRefineRequest, user: CurrentUser):
    await run_in_threadpool(_limit, user.id, "paper_refine", settings.limit_research_per_day * 5, "paper refinements")
    try:
        res = await refine_latex_paper(
            req.topic, req.current_latex, req.instruction, req.sources, llm, req.report
        )
        return JSONResponse(res)
    except Exception as e:  # noqa: BLE001
        logging.exception("paper refinement failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/paper/download_zip")
def download_paper_zip(req: ZipDownloadRequest, user: CurrentUser):
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


# Network pages have their own addresses so works and profiles can be shared as links
@app.get("/network")
@app.get("/network/{rest:path}")
async def network_page(rest: str = ""):
    return FileResponse(FRONTEND / "index.html")


# An open project has its own address too, so Back, refresh and links to it work
@app.get("/library/{rest:path}")
async def library_page(rest: str = ""):
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
