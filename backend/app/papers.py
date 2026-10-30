"""Paper Studio: one shared paper per piece of research, written with the co-author in a chat.

A paper belongs to the research it was drafted from. Research in a project gives a paper every member of that
project can read, edit and talk to the co-author about; Unassigned research gives a paper only its owner sees.

The paper's subject comes from the server, never from the browser: the saved report's question, brief and
sources, plus the project's context (its description, notes and the paper it collaborates on). Drafting and
every chat turn are grounded in those.

Only one co-author task runs on a paper at a time. While it runs the paper is marked busy, other people see who
started it, and manual edits wait, so a revision can never overwrite someone's typing.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

import sqlalchemy as sa
from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .auth import Accounts
from .config import settings
from .db import new_id, now_ms, paper_messages, papers, project_members, projects, reports, users
from .errors import Conflict, Forbidden, Invalid, NotFound, consume
from .latex import MAX_PAPER_CHARS, coauthor_turn, draft_paper, resolve_template
from .llm import LLM
from .store import Store

log = logging.getLogger("nemosearch.papers")

MAX_CHAT_CHARS = 4000
# A task older than this was cut off (the server restarted mid-call); the paper is free again
BUSY_STALE_MS = 10 * 60 * 1000


class Papers:
    def __init__(self, store: Store, llm: LLM) -> None:
        self.store = store
        self.engine = store.engine
        self.llm = llm

    # ------------------------------------------------------------------ access
    def _paper(self, conn: sa.Connection, uid: str, paper_id: str, manage: bool = False) -> sa.Row:
        row = conn.execute(sa.select(papers).where(papers.c.id == paper_id)).first()
        if row is None:
            raise NotFound(paper_id)
        if row.project_id:
            role = self.store._role(conn, uid, row.project_id)
            if role is None:
                raise NotFound(paper_id)
            if manage and role != "owner" and row.owner_id != uid:
                raise Forbidden("Only the person who started this paper or the project owner can delete it.")
        elif row.owner_id != uid:
            raise NotFound(paper_id)
        return row

    @staticmethod
    def _busy(row: sa.Row) -> bool:
        return bool(row.busy_by) and (row.busy_since or 0) > now_ms() - BUSY_STALE_MS

    def _claim(self, conn: sa.Connection, row: sa.Row, uid: str, task: str) -> None:
        """Marks the paper busy for one co-author task, or explains who is using it."""
        taken = conn.execute(papers.update().where(
            papers.c.id == row.id,
            sa.or_(papers.c.busy_by.is_(None), papers.c.busy_since < now_ms() - BUSY_STALE_MS),
        ).values(busy_by=uid, busy_since=now_ms(), busy_task=task[:200])).rowcount
        if not taken:
            current = conn.execute(sa.select(papers.c.busy_by, papers.c.busy_task).where(papers.c.id == row.id)).one()
            who = "you" if current.busy_by == uid else (conn.execute(
                sa.select(users.c.name).where(users.c.id == current.busy_by)).scalar() or "someone")
            raise Conflict(f"The co-author is still working on a request from {who} ({current.busy_task}). "
                           "Send yours when it has finished.")

    def _release(self, paper_id: str, **values: Any) -> None:
        with self.engine.begin() as conn:
            conn.execute(papers.update().where(papers.c.id == paper_id).values(
                busy_by=None, busy_since=None, busy_task=None, **values))

    # ------------------------------------------------------------------ reading
    @staticmethod
    def _title(row: sa.Row) -> str:
        m = re.search(r"\\title\{([^}]*)\}", row.latex or "")
        return " ".join(m.group(1).replace("\\\\", " ").split()) if m else (row.question or "Untitled paper")

    def _summary(self, conn: sa.Connection, row: sa.Row) -> dict:
        busy = None
        if self._busy(row):
            busy = {"by": conn.execute(sa.select(users.c.name).where(users.c.id == row.busy_by)).scalar() or "Someone",
                    "byId": row.busy_by, "task": row.busy_task, "since": row.busy_since}
        return {"id": row.id, "reportId": row.report_id, "projectId": row.project_id, "title": self._title(row),
                "question": row.question, "templateId": row.template_id, "version": row.version,
                "hasDraft": bool(row.latex.strip()), "busy": busy, "updatedAt": row.updated_at}

    @staticmethod
    def _message_dict(r: sa.Row, uid: str) -> dict:
        return {"id": r.id, "role": r.role, "body": r.body, "version": r.version, "createdAt": r.created_at,
                "mine": r.author_id == uid, "author": {"id": r.author_id, "name": r.name} if r.role == "author" else None}

    def _messages(self, conn: sa.Connection, uid: str, paper_id: str, after: Optional[int]) -> list[dict]:
        q = (sa.select(paper_messages, users.c.name).join(users, users.c.id == paper_messages.c.author_id, isouter=True)
             .where(paper_messages.c.paper_id == paper_id))
        if after is not None:
            q = q.where(paper_messages.c.created_at > after)
        rows = conn.execute(q.order_by(paper_messages.c.created_at.desc(), paper_messages.c.id.desc()).limit(200)).all()
        return [self._message_dict(r, uid) for r in reversed(rows)]

    def list(self, uid: str) -> list[dict]:
        with self.engine.connect() as conn:
            visible = sa.or_(sa.and_(papers.c.project_id.is_(None), papers.c.owner_id == uid),
                             papers.c.project_id.in_(self.store._visible_projects(uid)))
            rows = conn.execute(sa.select(papers).where(visible).order_by(papers.c.updated_at.desc())).all()
            return [self._summary(conn, r) for r in rows]

    def get(self, uid: str, paper_id: str, after: Optional[int] = None) -> dict:
        """The paper with its LaTeX, and the chat (only messages newer than `after` when given, for polling)."""
        with self.engine.connect() as conn:
            row = self._paper(conn, uid, paper_id)
            return {**self._summary(conn, row), "latex": row.latex, "bibtex": row.bibtex,
                    "authors": self._authors(conn, row), "messages": self._messages(conn, uid, paper_id, after)}

    # ------------------------------------------------------------------ grounding
    @staticmethod
    def _authors(conn: sa.Connection, row: sa.Row) -> list[dict]:
        """The people writing the paper: the project's owner and members, or the account that started it."""
        order = [row.owner_id]
        if row.project_id:
            # Project owner first, then members in the order they joined
            order = [conn.execute(sa.select(projects.c.owner_id).where(projects.c.id == row.project_id)).scalar()] + list(
                conn.execute(sa.select(project_members.c.user_id).where(project_members.c.project_id == row.project_id)
                             .order_by(project_members.c.added_at)).scalars())
        found = {p.id: p for p in conn.execute(sa.select(users.c.id, users.c.name, users.c.affiliation).where(users.c.id.in_(order)))}
        return [{"id": i, "name": found[i].name, "affiliation": found[i].affiliation} for i in order if i in found]

    def _grounding(self, uid: str, paper_id: str) -> dict:
        """What the co-author writes from. The report is re-read so follow-ups and sources added since count."""
        with self.engine.begin() as conn:
            row = self._paper(conn, uid, paper_id)
            report = conn.execute(sa.select(reports).where(reports.c.id == row.report_id, reports.c.deleted.is_(False))).first() \
                if row.report_id else None
            if report is not None:
                brief = report.report_text or ""
                followups = json.loads(report.followups_json or "[]")
                for turn in followups[-5:]:
                    if isinstance(turn, dict) and turn.get("question") and turn.get("answer"):
                        brief += f"\n\nFollow-up question: {turn['question']}\nAnswer: {turn['answer']}"
                conn.execute(papers.update().where(papers.c.id == row.id).values(
                    question=report.question or report.title, brief=brief, sources_json=report.sources_json or "[]"))
                row = conn.execute(sa.select(papers).where(papers.c.id == row.id)).one()
            title = report.title if report is not None else row.question
            authors = self._authors(conn, row)
        context = self.store.project_context(uid, row.project_id) if row.project_id else None
        return {"question": row.question, "title": title or row.question, "brief": row.brief,
                "sources": json.loads(row.sources_json or "[]"), "context": context["text"] if context else "",
                "work": context["work"] if context else None, "authors": authors,
                "template_id": row.template_id, "latex": row.latex}

    # ------------------------------------------------------------------ writing
    def create(self, uid: str, report_id: str, template_id: str = "neurips") -> dict:
        """The paper for this research, made on first use. Everyone who can read the research gets the same one."""
        with self.engine.begin() as conn:
            report = self.store._report(conn, uid, report_id)
            existing = conn.execute(sa.select(papers.c.id).where(papers.c.report_id == report_id)).scalar()
            if existing is None:
                existing = new_id("paper")
                conn.execute(papers.insert().values(
                    id=existing, owner_id=uid, project_id=report.project_id, report_id=report_id,
                    question=report.question or report.title, brief=report.report_text or "",
                    sources_json=report.sources_json or "[]", template_id=template_id[:80],
                    created_at=now_ms(), updated_at=now_ms(),
                ))
        return self.get(uid, existing)

    def _post(self, conn: sa.Connection, paper_id: str, role: str, body: str, author_id: Optional[str] = None,
              version: Optional[int] = None) -> None:
        conn.execute(paper_messages.insert().values(id=new_id("pmsg"), paper_id=paper_id, author_id=author_id, role=role,
                                                    body=body, version=version, created_at=now_ms()))

    async def draft(self, user: sa.Row, paper_id: str, template_id: Optional[str]) -> dict:
        def start() -> sa.Row:
            with self.engine.begin() as conn:
                row = self._paper(conn, user.id, paper_id)
                consume(conn, user.id, "paper", settings.limit_research_per_day, "paper drafts")
                self._claim(conn, row, user.id, "writing a new draft")
                if template_id:
                    conn.execute(papers.update().where(papers.c.id == paper_id).values(template_id=template_id[:80]))
                return row

        await run_in_threadpool(start)
        try:
            g = await run_in_threadpool(self._grounding, user.id, paper_id)
            custom = await run_in_threadpool(self.store.list_templates, user.id)
            tpl = resolve_template(g["template_id"], custom)
            res = await draft_paper(g, tpl, self.llm, await run_in_threadpool(self._conversation, user.id, paper_id))
        except Exception:  # noqa: BLE001
            log.exception("paper draft failed")
            await run_in_threadpool(self._fail, paper_id, "I couldn't finish the draft because the writing model "
                                                          "didn't answer. Nothing changed; try again in a moment.")
            return await run_in_threadpool(self.get, user.id, paper_id)

        n = len(g["sources"])
        basis = f"the research \"{g['question']}\" ({n} source{'s' if n != 1 else ''}"
        basis += f") and the project's paper \"{g['work']}\"" if g.get("work") else ")"
        questions = res["questions"] or ("What should the paper argue or contribute? Is there anything of your own, "
                                         "such as results or data, that it should include?")
        note = f"{user.name} asked for a draft. I wrote it from {basis}. {questions}"

        def finish() -> None:
            with self.engine.begin() as conn:
                version = conn.execute(sa.select(papers.c.version).where(papers.c.id == paper_id)).scalar() + 1
                conn.execute(papers.update().where(papers.c.id == paper_id).values(
                    latex=res["latex"], bibtex=res["bibtex"], version=version, updated_at=now_ms(),
                    busy_by=None, busy_since=None, busy_task=None))
                self._post(conn, paper_id, "coauthor", note, version=version)

        await run_in_threadpool(finish)
        return await run_in_threadpool(self.get, user.id, paper_id)

    def _conversation(self, uid: str, paper_id: str) -> list[dict]:
        """The recent chat as the model reads it: who said what, oldest first."""
        with self.engine.connect() as conn:
            msgs = self._messages(conn, uid, paper_id, None)[-14:]
        return [{"speaker": (m["author"]["name"] or "Former author") if m["author"] else "Co-author", "text": m["body"]}
                for m in msgs]

    def _fail(self, paper_id: str, message: str) -> None:
        self._release(paper_id)
        with self.engine.begin() as conn:
            self._post(conn, paper_id, "coauthor", message)

    async def send(self, user: sa.Row, paper_id: str, body: str) -> dict:
        """Posts the author's message, then lets the co-author answer it (and revise the paper if asked)."""
        text = body.strip()
        if not text:
            raise Invalid("Write a message first.")
        if len(text) > MAX_CHAT_CHARS:
            raise Invalid(f"Messages can be up to {MAX_CHAT_CHARS} characters; this one has {len(text)}.")

        def start() -> None:
            with self.engine.begin() as conn:
                row = self._paper(conn, user.id, paper_id)
                consume(conn, user.id, "paper_refine", settings.limit_research_per_day * 5, "co-author messages")
                self._claim(conn, row, user.id, f"\"{' '.join(text.split())[:60]}\"")
                self._post(conn, paper_id, "author", text, author_id=user.id)

        await run_in_threadpool(start)
        try:
            g = await run_in_threadpool(self._grounding, user.id, paper_id)

            conversation = await run_in_threadpool(self._conversation, user.id, paper_id)
            res = await coauthor_turn(g, g["latex"], conversation, self.llm)
        except Exception:  # noqa: BLE001
            log.exception("co-author turn failed")
            await run_in_threadpool(self._fail, paper_id, "I couldn't answer that because the writing model didn't "
                                                          "respond. Nothing in the paper changed; send it again in a moment.")
            return await run_in_threadpool(self.get, user.id, paper_id)

        def finish() -> None:
            with self.engine.begin() as conn:
                version = None
                if res["latex"] and len(res["latex"]) <= MAX_PAPER_CHARS * 1.5:
                    version = conn.execute(sa.select(papers.c.version).where(papers.c.id == paper_id)).scalar() + 1
                    conn.execute(papers.update().where(papers.c.id == paper_id).values(
                        latex=res["latex"], version=version, updated_at=now_ms()))
                conn.execute(papers.update().where(papers.c.id == paper_id).values(
                    busy_by=None, busy_since=None, busy_task=None))
                self._post(conn, paper_id, "coauthor", res["reply"], version=version)

        await run_in_threadpool(finish)
        return await run_in_threadpool(self.get, user.id, paper_id)

    def edit(self, uid: str, paper_id: str, base_version: int, latex: Optional[str], bibtex: Optional[str],
             template_id: Optional[str]) -> dict:
        """An author's own edit, saved only if nobody (person or co-author) changed the paper since `base_version`."""
        values: dict[str, Any] = {}
        if latex is not None:
            if len(latex) > MAX_PAPER_CHARS * 2:
                raise Invalid("The paper is too long to save here; split it into smaller sections.")
            values["latex"] = latex
        if bibtex is not None:
            values["bibtex"] = bibtex[:200_000]
        if template_id:
            values["template_id"] = template_id[:80]
        with self.engine.begin() as conn:
            row = self._paper(conn, uid, paper_id)
            if self._busy(row):
                raise Conflict("The co-author is revising the paper right now. Your edit wasn't saved; make it again "
                               "when the revision has arrived.")
            if values.keys() & {"latex", "bibtex"}:
                values.update(version=row.version + 1, updated_at=now_ms())
                changed = conn.execute(papers.update().where(papers.c.id == paper_id, papers.c.version == base_version)
                                       .values(**values)).rowcount
                if not changed:
                    raise Conflict("Someone else changed the paper while you were editing. The latest version is "
                                   "loaded; make your edit again.")
            elif values:
                conn.execute(papers.update().where(papers.c.id == paper_id).values(**values))
        return self.get(uid, paper_id, after=now_ms())

    def delete(self, uid: str, paper_id: str) -> None:
        with self.engine.begin() as conn:
            self._paper(conn, uid, paper_id, manage=True)
            conn.execute(papers.delete().where(papers.c.id == paper_id))


class PaperCreate(BaseModel):
    reportId: str
    templateId: str = "neurips"


class PaperDraft(BaseModel):
    templateId: Optional[str] = None


class PaperMessage(BaseModel):
    body: str = Field(max_length=MAX_CHAT_CHARS * 2)


class PaperEdit(BaseModel):
    baseVersion: int
    latex: Optional[str] = None
    bibtex: Optional[str] = None
    templateId: Optional[str] = None


def build_router(svc: Papers, accounts: Accounts) -> APIRouter:
    r = APIRouter(prefix="/api/papers")
    me = accounts.require_user

    @r.get("")
    def list_papers(request: Request):
        return svc.list(me(request).id)

    @r.post("", status_code=201)
    def create(request: Request, body: PaperCreate):
        return svc.create(me(request).id, body.reportId, body.templateId)

    @r.get("/{paper_id}")
    def get(request: Request, paper_id: str, after: Optional[int] = None):
        return svc.get(me(request).id, paper_id, after)

    @r.post("/{paper_id}/draft")
    async def draft(request: Request, paper_id: str, body: PaperDraft):
        return await svc.draft(await run_in_threadpool(me, request), paper_id, body.templateId)

    @r.post("/{paper_id}/messages")
    async def message(request: Request, paper_id: str, body: PaperMessage):
        return await svc.send(await run_in_threadpool(me, request), paper_id, body.body)

    @r.patch("/{paper_id}")
    def edit(request: Request, paper_id: str, body: PaperEdit):
        return svc.edit(me(request).id, paper_id, body.baseVersion, body.latex, body.bibtex, body.templateId)

    @r.delete("/{paper_id}")
    def delete(request: Request, paper_id: str):
        svc.delete(me(request).id, paper_id)
        return {"ok": True}

    return r
