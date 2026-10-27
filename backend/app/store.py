"""Server-side persistence for projects and research history (SQLite on the NemoSearch server).

Everything a user keeps — reports, saved sources, notes, attachments and export records —
lives here so it survives reloads and future sessions. Attachments are stored as files next
to the database. Reports and projects use soft deletion so the UI can offer Undo.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    question TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'All web',
    time_label TEXT NOT NULL DEFAULT '',
    sources_count INTEGER NOT NULL DEFAULT 0,
    report_text TEXT NOT NULL DEFAULT '',
    sources_json TEXT NOT NULL DEFAULT '[]',
    reasoning TEXT NOT NULL DEFAULT '',
    models_json TEXT NOT NULL DEFAULT '{}',
    coverage_json TEXT NOT NULL DEFAULT '{}',
    followups_json TEXT NOT NULL DEFAULT '[]',
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER
);
CREATE INDEX IF NOT EXISTS reports_project ON reports(project_id);
CREATE TABLE IF NOT EXISTS saved_sources (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    source_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT,
    created_at INTEGER NOT NULL
);
"""

MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024


def _now() -> int:
    return int(time.time() * 1000)


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class NotFound(Exception):
    pass


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.files = path.parent / "attachments"
        self.files.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)
        # Databases created before the coverage log existed
        columns = {r["name"] for r in self.db.execute("PRAGMA table_info(reports)")}
        if "coverage_json" not in columns:
            self.db.execute("ALTER TABLE reports ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '{}'")
        if "followups_json" not in columns:
            self.db.execute("ALTER TABLE reports ADD COLUMN followups_json TEXT NOT NULL DEFAULT '[]'")
        self.db.commit()

    # ------------------------------------------------------------------ helpers
    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def _x(self, sql: str, args: tuple = ()) -> int:
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.rowcount

    def _project_exists(self, project_id: Optional[str]) -> bool:
        return bool(project_id) and bool(self._q("SELECT 1 FROM projects WHERE id = ?", (project_id,)))

    def resolve_project(self, project_id: Optional[str]) -> Optional[str]:
        """Returns the id if it names a real project, else None (Unassigned)."""
        return project_id if self._project_exists(project_id) else None

    # ------------------------------------------------------------------ projects
    def _project_dict(self, row: sqlite3.Row) -> dict:
        counts = self._q(
            """SELECT
                 (SELECT COUNT(*) FROM reports WHERE project_id = ? AND deleted = 0) AS reports,
                 (SELECT COUNT(*) FROM saved_sources WHERE project_id = ?) AS sources,
                 (SELECT COUNT(*) FROM attachments WHERE project_id = ?) AS attachments,
                 (SELECT COUNT(*) FROM exports WHERE project_id = ?) AS exports""",
            (row["id"],) * 4,
        )[0]
        return {
            "id": row["id"], "name": row["name"], "description": row["description"], "notes": row["notes"],
            "archived": bool(row["archived"]), "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "counts": dict(counts),
        }

    def list_projects(self) -> list[dict]:
        return [self._project_dict(r) for r in self._q("SELECT * FROM projects ORDER BY archived, updated_at DESC")]

    def get_project(self, project_id: str) -> dict:
        rows = self._q("SELECT * FROM projects WHERE id = ?", (project_id,))
        if not rows:
            raise NotFound(project_id)
        project = self._project_dict(rows[0])
        project["sources"] = self.list_sources(project_id)
        project["attachments"] = self.list_attachments(project_id)
        project["exports"] = self.list_exports(project_id)
        return project

    def create_project(self, name: str, description: str = "") -> dict:
        pid, now = _id("project"), _now()
        self._x(
            "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (pid, name.strip()[:120], description.strip()[:500], now, now),
        )
        return self.get_project(pid)

    def update_project(self, project_id: str, patch: dict) -> dict:
        fields = {k: patch[k] for k in ("name", "description", "notes", "archived") if k in patch and patch[k] is not None}
        if "name" in fields:
            fields["name"] = str(fields["name"]).strip()[:120]
        if "archived" in fields:
            fields["archived"] = int(bool(fields["archived"]))
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            if not self._x(f"UPDATE projects SET {sets}, updated_at = ? WHERE id = ?", (*fields.values(), _now(), project_id)):
                raise NotFound(project_id)
        return self.get_project(project_id)

    def delete_project(self, project_id: str, delete_reports: bool) -> dict:
        """Removes the project, its notes, saved sources, attachments and export records.
        Its reports move to Unassigned unless delete_reports is set."""
        if not self._project_exists(project_id):
            raise NotFound(project_id)
        attachment_ids = [r["id"] for r in self._q("SELECT id FROM attachments WHERE project_id = ?", (project_id,))]
        if delete_reports:
            moved, deleted = 0, self._x("UPDATE reports SET deleted = 1, project_id = NULL WHERE project_id = ?", (project_id,))
        else:
            moved, deleted = self._x("UPDATE reports SET project_id = NULL WHERE project_id = ?", (project_id,)), 0
        self._x("DELETE FROM projects WHERE id = ?", (project_id,))
        for aid in attachment_ids:
            (self.files / aid).unlink(missing_ok=True)
        return {"movedReports": moved, "deletedReports": deleted}

    # ------------------------------------------------------------------ reports
    @staticmethod
    def _report_summary(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"], "projectId": row["project_id"], "title": row["title"], "question": row["question"],
            "mode": row["mode"], "time": row["time_label"], "sources": row["sources_count"],
            "archived": bool(row["archived"]), "createdAt": row["created_at"], "hasReport": bool(row["report_text"]),
        }

    def list_reports(self, project: str = "all") -> list[dict]:
        sql = "SELECT * FROM reports WHERE deleted = 0"
        args: tuple = ()
        if project == "unassigned":
            sql += " AND project_id IS NULL"
        elif project != "all":
            sql += " AND project_id = ?"
            args = (project,)
        sql += " ORDER BY COALESCE(created_at, 0) DESC, rowid DESC"
        return [self._report_summary(r) for r in self._q(sql, args)]

    def get_report(self, report_id: str) -> dict:
        rows = self._q("SELECT * FROM reports WHERE id = ? AND deleted = 0", (report_id,))
        if not rows:
            raise NotFound(report_id)
        row = rows[0]
        return {
            **self._report_summary(row),
            "reportText": row["report_text"],
            "sourcesData": json.loads(row["sources_json"] or "[]"),
            "reasoningTrace": row["reasoning"],
            "models": json.loads(row["models_json"] or "{}"),
            "coverage": json.loads(row["coverage_json"] or "{}"),
            "followups": json.loads(row["followups_json"] or "[]"),
        }

    def save_report(self, report: dict, project_id: Optional[str] = None) -> dict:
        rid = str(report.get("id") or _id("report"))
        self._x(
            """INSERT OR REPLACE INTO reports
               (id, project_id, title, question, mode, time_label, sources_count, report_text, sources_json,
                reasoning, models_json, coverage_json, followups_json, archived, deleted, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
            (
                rid, self.resolve_project(project_id if project_id is not None else report.get("projectId")),
                str(report.get("title") or report.get("question") or "Untitled research")[:200],
                str(report.get("question") or report.get("title") or ""),
                str(report.get("mode") or "All web"), str(report.get("time") or ""),
                int(report.get("sources") or 0), str(report.get("reportText") or ""),
                json.dumps(report.get("sourcesData") or []), str(report.get("reasoningTrace") or ""),
                json.dumps(report.get("models") or {}), json.dumps(report.get("coverage") or {}),
                json.dumps(report.get("followups") or []),
                int(bool(report.get("archived"))), report.get("createdAt"),
            ),
        )
        return self.get_report(rid)

    def import_reports(self, reports: list[dict]) -> int:
        """One-time import of history the browser kept before server persistence existed."""
        existing = {r["id"] for r in self._q("SELECT id FROM reports")}
        added = 0
        for report in reports:
            if report.get("id") and report["id"] in existing:
                continue
            self.save_report({**report, "projectId": None})
            added += 1
        return added

    def update_report(self, report_id: str, patch: dict) -> dict:
        fields: dict[str, Any] = {}
        if patch.get("title"):
            fields["title"] = str(patch["title"]).strip()[:200]
        if "archived" in patch and patch["archived"] is not None:
            fields["archived"] = int(bool(patch["archived"]))
        if "projectId" in patch:
            fields["project_id"] = self.resolve_project(patch["projectId"])
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            if not self._x(f"UPDATE reports SET {sets} WHERE id = ? AND deleted = 0", (*fields.values(), report_id)):
                raise NotFound(report_id)
        return self._report_summary(self._q("SELECT * FROM reports WHERE id = ?", (report_id,))[0])

    def add_followup(self, report_id: str, turn: dict, new_sources: list[dict]) -> None:
        """Appends one answered follow-up to the report's thread, with any sources it newly retrieved."""
        with self.lock:
            row = self.db.execute(
                "SELECT followups_json, sources_json FROM reports WHERE id = ? AND deleted = 0", (report_id,)
            ).fetchone()
            if not row:
                raise NotFound(report_id)
            thread = json.loads(row["followups_json"] or "[]") + [turn]
            sources = json.loads(row["sources_json"] or "[]")
            known = {s.get("id") for s in sources}
            sources += [s for s in new_sources if s.get("id") not in known]
            self.db.execute(
                "UPDATE reports SET followups_json = ?, sources_json = ?, sources_count = ? WHERE id = ?",
                (json.dumps(thread), json.dumps(sources), len(sources), report_id),
            )
            self.db.commit()

    def duplicate_report(self, report_id: str) -> dict:
        report = self.get_report(report_id)
        copy = {**report, "id": _id("report"), "title": f"{report['title']} (copy)", "createdAt": _now(), "archived": False}
        return self._report_summary(self._q("SELECT * FROM reports WHERE id = ?", (self.save_report(copy, report["projectId"])["id"],))[0])

    def set_report_deleted(self, report_id: str, deleted: bool) -> None:
        if not self._x("UPDATE reports SET deleted = ? WHERE id = ?", (int(deleted), report_id)):
            raise NotFound(report_id)

    # ------------------------------------------------------------------ saved sources
    def list_sources(self, project: str) -> list[dict]:
        sql = "SELECT * FROM saved_sources WHERE " + ("project_id IS NULL" if project == "unassigned" else "project_id = ?")
        rows = self._q(sql + " ORDER BY created_at DESC", () if project == "unassigned" else (project,))
        return [
            {"id": r["id"], "projectId": r["project_id"], "reportId": r["report_id"], "url": r["url"], "title": r["title"],
             "source": json.loads(r["source_json"]), "createdAt": r["created_at"]}
            for r in rows
        ]

    def save_source(self, project_id: Optional[str], report_id: Optional[str], source: dict) -> dict:
        project_id = self.resolve_project(project_id)
        url = str(source.get("url") or "")
        dupe = self._q(
            "SELECT id FROM saved_sources WHERE url = ? AND " + ("project_id IS NULL" if project_id is None else "project_id = ?"),
            (url,) if project_id is None else (url, project_id),
        )
        if dupe:
            sid = dupe[0]["id"]
        else:
            sid = _id("source")
            report_ok = report_id if report_id and self._q("SELECT 1 FROM reports WHERE id = ?", (report_id,)) else None
            self._x(
                "INSERT INTO saved_sources (id, project_id, report_id, url, title, source_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, project_id, report_ok, url, str(source.get("title") or url)[:300], json.dumps(source), _now()),
            )
        return next(s for s in self.list_sources(project_id or "unassigned") if s["id"] == sid)

    def delete_source(self, source_id: str) -> None:
        if not self._x("DELETE FROM saved_sources WHERE id = ?", (source_id,)):
            raise NotFound(source_id)

    # ------------------------------------------------------------------ attachments
    def list_attachments(self, project_id: str) -> list[dict]:
        rows = self._q("SELECT * FROM attachments WHERE project_id = ? ORDER BY created_at DESC", (project_id,))
        return [{"id": r["id"], "filename": r["filename"], "contentType": r["content_type"], "size": r["size"], "createdAt": r["created_at"]} for r in rows]

    def add_attachment(self, project_id: str, filename: str, content_type: str, data: bytes) -> dict:
        if not self._project_exists(project_id):
            raise NotFound(project_id)
        aid = _id("file")
        (self.files / aid).write_bytes(data)
        safe_name = os.path.basename(filename).strip()[:200] or "attachment"
        self._x(
            "INSERT INTO attachments (id, project_id, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (aid, project_id, safe_name, content_type[:100], len(data), _now()),
        )
        return next(a for a in self.list_attachments(project_id) if a["id"] == aid)

    def attachment_file(self, attachment_id: str) -> tuple[Path, str, str]:
        rows = self._q("SELECT * FROM attachments WHERE id = ?", (attachment_id,))
        if not rows:
            raise NotFound(attachment_id)
        return self.files / attachment_id, rows[0]["filename"], rows[0]["content_type"]

    def delete_attachment(self, attachment_id: str) -> None:
        if not self._x("DELETE FROM attachments WHERE id = ?", (attachment_id,)):
            raise NotFound(attachment_id)
        (self.files / attachment_id).unlink(missing_ok=True)

    # ------------------------------------------------------------------ exports
    def list_exports(self, project_id: str) -> list[dict]:
        rows = self._q("SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC", (project_id,))
        return [
            {"id": r["id"], "reportId": r["report_id"], "kind": r["kind"], "filename": r["filename"],
             "downloadable": r["content"] is not None, "createdAt": r["created_at"]}
            for r in rows
        ]

    def add_export(self, project_id: Optional[str], report_id: Optional[str], kind: str, filename: str, content: Optional[str]) -> dict:
        eid = _id("export")
        report_ok = report_id if report_id and self._q("SELECT 1 FROM reports WHERE id = ?", (report_id,)) else None
        self._x(
            "INSERT INTO exports (id, project_id, report_id, kind, filename, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (eid, self.resolve_project(project_id), report_ok, kind[:40], filename[:200], content, _now()),
        )
        return {"id": eid}

    def export_content(self, export_id: str) -> tuple[str, str]:
        rows = self._q("SELECT filename, content FROM exports WHERE id = ?", (export_id,))
        if not rows or rows[0]["content"] is None:
            raise NotFound(export_id)
        return rows[0]["filename"], rows[0]["content"]


def open_store(root: Path) -> Store:
    path = Path(os.getenv("NEMOSEARCH_DB", root / "data" / "nemosearch.db"))
    path.parent.mkdir(parents=True, exist_ok=True)
    return Store(path)
