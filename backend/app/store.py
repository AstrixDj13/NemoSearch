"""Private research for each account: projects, reports, saved sources, attachments, exports and templates.

Every method takes the signed-in account (`uid`) and checks it before touching a row:

- Anything outside a project (Unassigned) is visible only to the account that made it.
- A project is visible to its owner and to the people it is shared with (members). Members can read
  everything in it, write notes, and add their own research, sources and files.
- Renaming, archiving, deleting and sharing a project are for its owner. Research, sources and files can
  be removed by whoever added them and by the project owner.

Things the caller may not see raise NotFound rather than Forbidden, so ids cannot be probed for existence.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Any, Optional

import sqlalchemy as sa

from . import notify
from .blobs import BlobStore
from .db import (
    attachments, exports, new_id, now_ms, paper_templates, project_members, projects, reports, saved_sources, users,
)
from .errors import Forbidden, Invalid, NotFound, consume

MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
ATTACHMENTS_PER_DAY = 100

__all__ = ["Store", "NotFound", "Forbidden", "Invalid", "MAX_ATTACHMENT_BYTES"]


def _seq() -> int:
    return time.time_ns() // 1000


class Store:
    def __init__(self, engine: sa.Engine, blobs: BlobStore) -> None:
        self.engine = engine
        self.blobs = blobs

    # ------------------------------------------------------------------ access rules
    @staticmethod
    def _role(conn: sa.Connection, uid: str, project_id: Optional[str]) -> Optional[str]:
        """'owner', 'member', or None when the account has no access (or the project does not exist)."""
        if not project_id:
            return None
        owner = conn.execute(sa.select(projects.c.owner_id).where(projects.c.id == project_id)).scalar()
        if owner is None:
            return None
        if owner == uid:
            return "owner"
        member = conn.execute(sa.select(project_members.c.user_id).where(
            project_members.c.project_id == project_id, project_members.c.user_id == uid
        )).scalar()
        return "member" if member else None

    def _need_role(self, conn: sa.Connection, uid: str, project_id: str, owner: bool = False) -> str:
        role = self._role(conn, uid, project_id)
        if role is None:
            raise NotFound(project_id)
        if owner and role != "owner":
            raise Forbidden("Only the project owner can do that.")
        return role

    def _accessible(self, conn: sa.Connection, uid: str, project_id: Optional[str]) -> Optional[str]:
        """The project id if the account can add to it, else None (Unassigned)."""
        return project_id if self._role(conn, uid, project_id) else None

    @staticmethod
    def _visible_projects(uid: str) -> sa.Select:
        member_of = sa.select(project_members.c.project_id).where(project_members.c.user_id == uid)
        return sa.select(projects.c.id).where(sa.or_(projects.c.owner_id == uid, projects.c.id.in_(member_of)))

    def _report(self, conn: sa.Connection, uid: str, report_id: str, manage: bool = False) -> sa.Row:
        row = conn.execute(sa.select(reports).where(reports.c.id == report_id, reports.c.deleted.is_(False))).first()
        if row is None:
            raise NotFound(report_id)
        if row.owner_id == uid:
            return row
        role = self._role(conn, uid, row.project_id)
        if role is None:
            raise NotFound(report_id)
        if manage and role != "owner":
            raise Forbidden("Only the person who ran this research or the project owner can change it.")
        return row

    def accessible_project(self, uid: str, project_id: Optional[str]) -> Optional[str]:
        with self.engine.connect() as conn:
            return self._accessible(conn, uid, project_id)

    def can_read_report(self, uid: str, report_id: str) -> bool:
        with self.engine.connect() as conn:
            try:
                self._report(conn, uid, report_id)
                return True
            except NotFound:
                return False

    # ------------------------------------------------------------------ projects
    def _project_dict(self, conn: sa.Connection, row: sa.Row, uid: str) -> dict:
        def count(table: sa.Table, *extra) -> int:  # noqa: ANN002
            return conn.execute(sa.select(sa.func.count()).select_from(table).where(table.c.project_id == row.id, *extra)).scalar_one()

        owner = conn.execute(sa.select(users.c.id, users.c.name, users.c.orcid).where(users.c.id == row.owner_id)).first()
        return {
            "id": row.id, "name": row.name, "description": row.description, "notes": row.notes,
            "archived": bool(row.archived), "createdAt": row.created_at, "updatedAt": row.updated_at,
            "role": "owner" if row.owner_id == uid else "member",
            "owner": {"id": owner.id, "name": owner.name, "orcid": owner.orcid} if owner else None,
            "counts": {
                "reports": count(reports, reports.c.deleted.is_(False)),
                "sources": count(saved_sources),
                "attachments": count(attachments),
                "exports": count(exports),
                "members": count(project_members),
            },
        }

    def list_projects(self, uid: str) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                sa.select(projects).where(projects.c.id.in_(self._visible_projects(uid)))
                .order_by(projects.c.archived, projects.c.updated_at.desc())
            ).all()
            return [self._project_dict(conn, r, uid) for r in rows]

    def get_project(self, uid: str, project_id: str) -> dict:
        with self.engine.connect() as conn:
            self._need_role(conn, uid, project_id)
            row = conn.execute(sa.select(projects).where(projects.c.id == project_id)).one()
            project = self._project_dict(conn, row, uid)
            project["sources"] = self._sources(conn, uid, project_id)
            project["attachments"] = self._attachments(conn, project_id)
            project["exports"] = self._exports(conn, project_id)
            project["members"] = self._members(conn, project_id)
            return project

    def create_project(self, uid: str, name: str, description: str = "") -> dict:
        pid, now = new_id("project"), now_ms()
        with self.engine.begin() as conn:
            conn.execute(projects.insert().values(
                id=pid, owner_id=uid, name=name.strip()[:120], description=description.strip()[:500],
                notes="", archived=False, created_at=now, updated_at=now,
            ))
        return self.get_project(uid, pid)

    def update_project(self, uid: str, project_id: str, patch: dict) -> dict:
        fields = {k: patch[k] for k in ("name", "description", "notes", "archived") if patch.get(k) is not None}
        with self.engine.begin() as conn:
            # Members may keep the shared notes; everything else belongs to the owner
            self._need_role(conn, uid, project_id, owner=bool(set(fields) - {"notes"}))
            if "name" in fields:
                fields["name"] = str(fields["name"]).strip()[:120]
            if "description" in fields:
                fields["description"] = str(fields["description"]).strip()[:500]
            if "archived" in fields:
                fields["archived"] = bool(fields["archived"])
            if fields:
                conn.execute(projects.update().where(projects.c.id == project_id).values(**fields, updated_at=now_ms()))
        return self.get_project(uid, project_id)

    def delete_project(self, uid: str, project_id: str, delete_reports: bool) -> dict:
        """Removes the project with its notes, saved sources, attachments, exports and sharing.
        Its reports move to their authors' Unassigned unless delete_reports is set."""
        with self.engine.begin() as conn:
            self._need_role(conn, uid, project_id, owner=True)
            keys = conn.execute(sa.select(attachments.c.blob_key).where(attachments.c.project_id == project_id)).scalars().all()
            in_project = reports.c.project_id == project_id
            if delete_reports:
                moved, deleted = 0, conn.execute(reports.update().where(in_project).values(deleted=True, project_id=None)).rowcount
            else:
                moved, deleted = conn.execute(reports.update().where(in_project).values(project_id=None)).rowcount, 0
            conn.execute(projects.delete().where(projects.c.id == project_id))
        for key in keys:
            self.blobs.delete(key)
        return {"movedReports": moved, "deletedReports": deleted}

    # ------------------------------------------------------------------ sharing
    @staticmethod
    def _members(conn: sa.Connection, project_id: str) -> list[dict]:
        rows = conn.execute(
            sa.select(users.c.id, users.c.name, users.c.orcid, users.c.affiliation, project_members.c.added_at)
            .join(project_members, project_members.c.user_id == users.c.id)
            .where(project_members.c.project_id == project_id).order_by(project_members.c.added_at)
        ).all()
        return [{"id": r.id, "name": r.name, "orcid": r.orcid, "affiliation": r.affiliation, "addedAt": r.added_at} for r in rows]

    def add_member(self, uid: str, project_id: str, orcid: str) -> list[dict]:
        emails: list = []
        with self.engine.begin() as conn:
            self._need_role(conn, uid, project_id, owner=True)
            target = conn.execute(sa.select(users.c.id).where(users.c.orcid == orcid.strip())).scalar()
            if target is None:
                raise Invalid("Nobody with that ORCID iD has a NemoSearch account yet. Ask them to sign in once, then share again.")
            if target == uid:
                raise Invalid("You already own this project.")
            self.add_member_conn(conn, project_id, target, uid)
            name = conn.execute(sa.select(projects.c.name).where(projects.c.id == project_id)).scalar()
            emails = notify.add(conn, target, "project_shared", {"project_id": project_id, "project_name": name, "by": uid})
            members = self._members(conn, project_id)
        notify.send(emails)
        return members

    @staticmethod
    def add_member_conn(conn: sa.Connection, project_id: str, user_id: str, added_by: str) -> None:
        exists = conn.execute(sa.select(project_members.c.user_id).where(
            project_members.c.project_id == project_id, project_members.c.user_id == user_id
        )).first()
        if not exists:
            conn.execute(project_members.insert().values(project_id=project_id, user_id=user_id, added_by=added_by, added_at=now_ms()))

    def remove_member(self, uid: str, project_id: str, member_id: str) -> None:
        """The owner removes anyone; a member can remove themselves (leave)."""
        with self.engine.begin() as conn:
            role = self._need_role(conn, uid, project_id)
            if role != "owner" and member_id != uid:
                raise Forbidden("Only the project owner can remove other people.")
            if not conn.execute(project_members.delete().where(
                project_members.c.project_id == project_id, project_members.c.user_id == member_id
            )).rowcount:
                raise NotFound(member_id)

    # ------------------------------------------------------------------ reports
    def _summary(self, row: sa.Row, uid: str, owner_names: dict[str, str]) -> dict:
        return {
            "id": row.id, "projectId": row.project_id, "title": row.title, "question": row.question,
            "mode": row.mode, "time": row.time_label, "sources": row.sources_count,
            "archived": bool(row.archived), "createdAt": row.created_at, "hasReport": bool(row.report_text),
            "mine": row.owner_id == uid, "ownerName": owner_names.get(row.owner_id, ""),
        }

    def _names(self, conn: sa.Connection, ids: set[str]) -> dict[str, str]:
        if not ids:
            return {}
        return dict(conn.execute(sa.select(users.c.id, users.c.name).where(users.c.id.in_(ids))).all())

    def list_reports(self, uid: str, project: str = "all") -> list[dict]:
        with self.engine.connect() as conn:
            q = sa.select(reports).where(reports.c.deleted.is_(False))
            if project == "unassigned":
                q = q.where(reports.c.owner_id == uid, reports.c.project_id.is_(None))
            elif project == "all":
                q = q.where(sa.or_(reports.c.owner_id == uid, reports.c.project_id.in_(self._visible_projects(uid))))
            else:
                if self._role(conn, uid, project) is None:
                    return []
                q = q.where(reports.c.project_id == project)
            rows = conn.execute(q.order_by(sa.func.coalesce(reports.c.created_at, 0).desc(), reports.c.seq.desc())).all()
            names = self._names(conn, {r.owner_id for r in rows if r.owner_id != uid})
            return [self._summary(r, uid, names) for r in rows]

    def get_report(self, uid: str, report_id: str) -> dict:
        with self.engine.connect() as conn:
            row = self._report(conn, uid, report_id)
            return {
                **self._summary(row, uid, self._names(conn, {row.owner_id})),
                "reportText": row.report_text,
                "sourcesData": json.loads(row.sources_json or "[]"),
                "reasoningTrace": row.reasoning,
                "models": json.loads(row.models_json or "{}"),
                "coverage": json.loads(row.coverage_json or "{}"),
                "followups": json.loads(row.followups_json or "[]"),
            }

    def _report_values(self, report: dict) -> dict:
        return {
            "title": str(report.get("title") or report.get("question") or "Untitled research")[:200],
            "question": str(report.get("question") or report.get("title") or ""),
            "mode": str(report.get("mode") or "All web")[:40], "time_label": str(report.get("time") or "")[:60],
            "sources_count": int(report.get("sources") or 0), "report_text": str(report.get("reportText") or ""),
            "sources_json": json.dumps(report.get("sourcesData") or []),
            "reasoning": str(report.get("reasoningTrace") or ""),
            "models_json": json.dumps(report.get("models") or {}), "coverage_json": json.dumps(report.get("coverage") or {}),
            "followups_json": json.dumps(report.get("followups") or []),
            "archived": bool(report.get("archived")), "created_at": report.get("createdAt"),
        }

    def save_report(self, uid: str, report: dict, project_id: Optional[str] = None) -> dict:
        rid = new_id("report")
        with self.engine.begin() as conn:
            pid = self._accessible(conn, uid, project_id if project_id is not None else report.get("projectId"))
            conn.execute(reports.insert().values(
                id=rid, owner_id=uid, project_id=pid, deleted=False, seq=_seq(), **self._report_values(report)
            ))
        return self.get_report(uid, rid)

    def import_reports(self, uid: str, items: list[dict]) -> int:
        """One-time import of history a browser kept before server persistence existed. Always creates new
        reports owned by the caller; ids from the browser are never trusted."""
        for report in items[:500]:
            self.save_report(uid, {**report, "projectId": None})
        return min(len(items), 500)

    def update_report(self, uid: str, report_id: str, patch: dict) -> dict:
        with self.engine.begin() as conn:
            self._report(conn, uid, report_id, manage=True)
            fields: dict[str, Any] = {}
            if patch.get("title"):
                fields["title"] = str(patch["title"]).strip()[:200]
            if patch.get("archived") is not None:
                fields["archived"] = bool(patch["archived"])
            if "projectId" in patch:
                target = patch["projectId"]
                if target and self._role(conn, uid, target) is None:
                    raise NotFound(target)
                fields["project_id"] = target or None
            if fields:
                conn.execute(reports.update().where(reports.c.id == report_id).values(**fields))
            row = conn.execute(sa.select(reports).where(reports.c.id == report_id)).one()
            return self._summary(row, uid, self._names(conn, {row.owner_id}))

    def add_followup(self, uid: str, report_id: str, turn: dict, new_sources: list[dict]) -> None:
        """Appends one answered follow-up to the report's thread, with any sources it newly retrieved."""
        with self.engine.begin() as conn:
            row = self._report(conn, uid, report_id)
            if conn.dialect.name == "postgresql":  # two follow-ups finishing together must not lose one
                row = conn.execute(sa.select(reports).where(reports.c.id == report_id).with_for_update()).one()
            thread = json.loads(row.followups_json or "[]") + [turn]
            sources = json.loads(row.sources_json or "[]")
            known = {s.get("id") for s in sources}
            sources += [s for s in new_sources if s.get("id") not in known]
            conn.execute(reports.update().where(reports.c.id == report_id).values(
                followups_json=json.dumps(thread), sources_json=json.dumps(sources), sources_count=len(sources),
            ))

    def duplicate_report(self, uid: str, report_id: str) -> dict:
        report = self.get_report(uid, report_id)
        copy = self.save_report(uid, {**report, "title": f"{report['title']} (copy)", "createdAt": now_ms(), "archived": False},
                                report["projectId"])
        return {k: v for k, v in copy.items() if k not in ("reportText", "sourcesData", "reasoningTrace", "models", "coverage", "followups")}

    def set_report_deleted(self, uid: str, report_id: str, deleted: bool) -> None:
        with self.engine.begin() as conn:
            row = conn.execute(sa.select(reports).where(reports.c.id == report_id)).first()
            if row is None:
                raise NotFound(report_id)
            if row.owner_id != uid and self._role(conn, uid, row.project_id) != "owner":
                raise NotFound(report_id)
            conn.execute(reports.update().where(reports.c.id == report_id).values(deleted=deleted))

    # ------------------------------------------------------------------ saved sources
    @staticmethod
    def _source_dict(r: sa.Row, uid: str) -> dict:
        return {"id": r.id, "projectId": r.project_id, "reportId": r.report_id, "url": r.url, "title": r.title,
                "source": json.loads(r.source_json), "createdAt": r.created_at, "mine": r.owner_id == uid}

    def _sources(self, conn: sa.Connection, uid: str, project: str) -> list[dict]:
        where = (sa.and_(saved_sources.c.owner_id == uid, saved_sources.c.project_id.is_(None))
                 if project == "unassigned" else saved_sources.c.project_id == project)
        rows = conn.execute(sa.select(saved_sources).where(where).order_by(saved_sources.c.created_at.desc())).all()
        return [self._source_dict(r, uid) for r in rows]

    def list_sources(self, uid: str, project: str) -> list[dict]:
        with self.engine.connect() as conn:
            if project != "unassigned":
                self._need_role(conn, uid, project)
            return self._sources(conn, uid, project)

    def save_source(self, uid: str, project_id: Optional[str], report_id: Optional[str], source: dict) -> dict:
        url = str(source.get("url") or "")
        with self.engine.begin() as conn:
            pid = self._accessible(conn, uid, project_id)
            scope = (saved_sources.c.project_id == pid) if pid else sa.and_(
                saved_sources.c.project_id.is_(None), saved_sources.c.owner_id == uid)
            sid = conn.execute(sa.select(saved_sources.c.id).where(saved_sources.c.url == url, scope)).scalar()
            if sid is None:
                sid = new_id("source")
                report_ok = None
                if report_id:
                    try:
                        report_ok = self._report(conn, uid, report_id).id
                    except NotFound:
                        pass
                conn.execute(saved_sources.insert().values(
                    id=sid, owner_id=uid, project_id=pid, report_id=report_ok, url=url,
                    title=str(source.get("title") or url)[:300], source_json=json.dumps(source), created_at=now_ms(),
                ))
            return self._source_dict(conn.execute(sa.select(saved_sources).where(saved_sources.c.id == sid)).one(), uid)

    def delete_source(self, uid: str, source_id: str) -> None:
        with self.engine.begin() as conn:
            row = conn.execute(sa.select(saved_sources).where(saved_sources.c.id == source_id)).first()
            if row is None or (row.owner_id != uid and self._role(conn, uid, row.project_id) != "owner"):
                raise NotFound(source_id)
            conn.execute(saved_sources.delete().where(saved_sources.c.id == source_id))

    # ------------------------------------------------------------------ attachments
    @staticmethod
    def _attachments(conn: sa.Connection, project_id: str) -> list[dict]:
        rows = conn.execute(sa.select(attachments).where(attachments.c.project_id == project_id)
                            .order_by(attachments.c.created_at.desc())).all()
        return [{"id": r.id, "filename": r.filename, "contentType": r.content_type, "size": r.size,
                 "createdAt": r.created_at, "ownerId": r.owner_id} for r in rows]

    def add_attachment(self, uid: str, project_id: str, filename: str, content_type: str, data: bytes) -> dict:
        aid = new_id("file")
        key = f"attachments/{aid}"
        safe_name = os.path.basename(filename.replace("\\", "/")).strip()[:200] or "attachment"
        with self.engine.begin() as conn:
            self._need_role(conn, uid, project_id)
            consume(conn, uid, "attachment", ATTACHMENTS_PER_DAY, "file uploads")
            self.blobs.put(key, data, content_type[:100])
            conn.execute(attachments.insert().values(
                id=aid, owner_id=uid, project_id=project_id, blob_key=key, filename=safe_name,
                content_type=content_type[:100], size=len(data), created_at=now_ms(),
            ))
            return next(a for a in self._attachments(conn, project_id) if a["id"] == aid)

    def attachment_link(self, uid: str, attachment_id: str) -> str:
        with self.engine.connect() as conn:
            row = conn.execute(sa.select(attachments).where(attachments.c.id == attachment_id)).first()
            if row is None or self._role(conn, uid, row.project_id) is None:
                raise NotFound(attachment_id)
        return self.blobs.download_url(row.blob_key, row.filename, row.content_type)

    def delete_attachment(self, uid: str, attachment_id: str) -> None:
        with self.engine.begin() as conn:
            row = conn.execute(sa.select(attachments).where(attachments.c.id == attachment_id)).first()
            role = self._role(conn, uid, row.project_id) if row else None
            if row is None or role is None:
                raise NotFound(attachment_id)
            if row.owner_id != uid and role != "owner":
                raise Forbidden("Only the person who added this file or the project owner can remove it.")
            conn.execute(attachments.delete().where(attachments.c.id == attachment_id))
        self.blobs.delete(row.blob_key)

    # ------------------------------------------------------------------ exports
    @staticmethod
    def _exports(conn: sa.Connection, project_id: str) -> list[dict]:
        rows = conn.execute(sa.select(exports).where(exports.c.project_id == project_id).order_by(exports.c.created_at.desc())).all()
        return [{"id": r.id, "reportId": r.report_id, "kind": r.kind, "filename": r.filename,
                 "downloadable": r.content is not None, "createdAt": r.created_at} for r in rows]

    def add_export(self, uid: str, project_id: Optional[str], report_id: Optional[str], kind: str, filename: str,
                   content: Optional[str]) -> dict:
        eid = new_id("export")
        with self.engine.begin() as conn:
            report_ok = None
            if report_id:
                try:
                    report_ok = self._report(conn, uid, report_id).id
                except NotFound:
                    pass
            conn.execute(exports.insert().values(
                id=eid, owner_id=uid, project_id=self._accessible(conn, uid, project_id), report_id=report_ok,
                kind=kind[:40], filename=filename[:200], content=content[:2_000_000] if content else None, created_at=now_ms(),
            ))
        return {"id": eid}

    def export_content(self, uid: str, export_id: str) -> tuple[str, str]:
        with self.engine.connect() as conn:
            row = conn.execute(sa.select(exports).where(exports.c.id == export_id)).first()
            if row is None or row.content is None:
                raise NotFound(export_id)
            if row.owner_id != uid and self._role(conn, uid, row.project_id) is None:
                raise NotFound(export_id)
            return row.filename, row.content

    # ------------------------------------------------------------------ Paper Studio templates
    def list_templates(self, uid: str) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(paper_templates).where(paper_templates.c.owner_id == uid)
                                .order_by(paper_templates.c.created_at)).all()
        return [{"id": r.id, "name": r.name, "venue": r.venue, "doc_class": r.doc_class, "preamble": r.preamble,
                 "bib_style": "\\bibliographystyle{unsrt}\n\\bibliography{references}", "custom": True} for r in rows]

    def install_template(self, uid: str, name: str, doc_class: str, preamble: str, venue: str) -> dict:
        slug = re.sub(r"[^a-z0-9_]", "", name.lower().replace(" ", "_"))[:30] or "template"
        tid = f"custom_{slug}_{hashlib.sha256(uid.encode()).hexdigest()[:8]}"
        values = {
            "name": name.strip()[:120] or "Custom template",
            "venue": venue.strip()[:200] or "Custom Journal / Conference Template",
            "doc_class": doc_class or "\\documentclass[11pt]{article}",
            "preamble": preamble or "\\usepackage{amsmath,amssymb,graphicx,booktabs,hyperref}",
        }
        with self.engine.begin() as conn:
            if conn.execute(sa.select(paper_templates.c.id).where(paper_templates.c.id == tid)).first():
                conn.execute(paper_templates.update().where(paper_templates.c.id == tid).values(**values))
            else:
                conn.execute(paper_templates.insert().values(id=tid, owner_id=uid, created_at=now_ms(), **values))
        return next(t for t in self.list_templates(uid) if t["id"] == tid)
