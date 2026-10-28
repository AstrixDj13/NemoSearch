"""NemoSearch Network: publish a work, let others discover it, request access or collaboration, owner decides.

Deliberately absent: feeds, likes, follower counts and any other engagement metric.

Visibility of a work:
- private  (the default): only the owner and people the owner invited. Never listed, searched or counted anywhere.
- request: title, authors, abstract and tags are public; the file is shared only with people the owner approves.
- open:    anyone can read and download it.

A work that is taken down by an admin is visible only to its owner and admins, whatever its visibility.
Anything a viewer may not see raises NotFound, so private works cannot be discovered by guessing ids.

Every uploaded file is hashed (SHA-256) and appended to the ownership log (see db.ownership_records): a
tamper-evident record of which account uploaded which bytes and when, by this server's clock. It is evidence
of upload, not a certificate of authorship.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from typing import Optional

import httpx
import sqlalchemy as sa
from fastapi import APIRouter, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from . import notify
from .auth import Accounts, normalize_orcid, public_user
from .blobs import BlobStore
from .config import settings
from .connectors.openalex import _abstract
from .db import (
    abuse_reports, access_requests, blocks, new_id, notifications, now_ms, org_members, organizations,
    ownership_records, project_members, projects, reports, users, work_access, work_versions, works,
)
from .errors import Conflict, Forbidden, Invalid, NotFound, consume
from .store import Store

LICENSES = {
    "cc-by": "CC BY 4.0",
    "cc-by-nc": "CC BY-NC 4.0",
    "cc0": "CC0 1.0 (public domain)",
    "arr": "All rights reserved",
}
# Only for claimed works, which link to the original instead of hosting a copy
EXTERNAL_LICENSE = {"external": "Set by the original publisher"}
VISIBILITIES = ("private", "request", "open")
ABUSE_REASONS = ("copyright", "spam", "impersonation", "harassment", "other")
GENESIS = "0" * 64
ROR_RE = re.compile(r"^0[a-hj-km-np-tv-z0-9]{6}[0-9]{2}$")
STOPWORDS = set("""a an the of in on for to and or vs versus how what why when which who is are was were be with by from
as at into about over under between than that this these those it its their there using use new study research
analysis approach based towards toward via""".split())


def _tokens(text: str, n: int = 8) -> list[str]:
    words = re.findall(r"[a-z0-9][a-z0-9\-]{2,}", (text or "").lower())
    out: list[str] = []
    for w in words:
        if w not in STOPWORDS and w not in out:
            out.append(w)
    return out[:n]


def _record_hash(record: dict) -> str:
    fields = ("id", "event", "work_id", "version_id", "user_id", "orcid", "sha256", "size", "filename", "created_at", "prev_hash")
    return hashlib.sha256(json.dumps({k: record[k] for k in fields}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Network:
    def __init__(self, engine: sa.Engine, blobs: BlobStore, store: Store) -> None:
        self.engine = engine
        self.blobs = blobs
        self.store = store
        self._chain_lock = threading.Lock()
        self.http = httpx.AsyncClient(timeout=20, headers={"User-Agent": "NemoSearch/1.0 (+network claims)"})

    # ------------------------------------------------------------------ access
    @staticmethod
    def _work(conn: sa.Connection, work_id: str) -> sa.Row:
        row = conn.execute(sa.select(works).where(works.c.id == work_id)).first()
        if row is None:
            raise NotFound(work_id)
        return row

    @staticmethod
    def _access(conn: sa.Connection, work: sa.Row, viewer: Optional[sa.Row]) -> Optional[str]:
        """owner | admin | granted | open | metadata, or None when the viewer may not know the work exists."""
        if viewer is not None and work.owner_id == viewer.id:
            return "owner"
        # Admins moderate what is shared; private works stay private even from them
        if viewer is not None and viewer.is_admin and work.visibility != "private":
            return "admin"
        if work.taken_down:
            return None
        if viewer is not None and conn.execute(sa.select(work_access.c.user_id).where(
                work_access.c.work_id == work.id, work_access.c.user_id == viewer.id)).first():
            return "granted"
        return {"open": "open", "request": "metadata"}.get(work.visibility)

    def _visible(self, conn: sa.Connection, work_id: str, viewer: Optional[sa.Row]) -> tuple[sa.Row, str]:
        work = self._work(conn, work_id)
        access = self._access(conn, work, viewer)
        if access is None:
            raise NotFound(work_id)
        return work, access

    def _owned(self, conn: sa.Connection, work_id: str, uid: str) -> sa.Row:
        work = self._work(conn, work_id)
        if work.owner_id != uid:
            # Someone who can see the work learns only that they may not change it
            if work.visibility == "private" or work.taken_down:
                raise NotFound(work_id)
            raise Forbidden("Only the owner can change this work.")
        return work

    # ------------------------------------------------------------------ presentation
    def _work_summary(self, conn: sa.Connection, w: sa.Row) -> dict:
        owner = conn.execute(sa.select(users.c.id, users.c.name, users.c.orcid, users.c.affiliation).where(users.c.id == w.owner_id)).first()
        org = conn.execute(sa.select(organizations.c.id, organizations.c.name, organizations.c.verified)
                           .where(organizations.c.id == w.org_id)).first() if w.org_id else None
        latest = conn.execute(sa.select(work_versions).where(work_versions.c.work_id == w.id)
                              .order_by(work_versions.c.version.desc()).limit(1)).first()
        return {
            "id": w.id, "title": w.title, "abstract": w.abstract, "authors": json.loads(w.authors_json),
            "tags": json.loads(w.tags_json), "license": {"id": w.license, "label": {**LICENSES, **EXTERNAL_LICENSE}.get(w.license, w.license)},
            "visibility": w.visibility, "externalUrl": w.external_url, "doi": w.doi, "claimed": bool(w.claimed),
            "claimEvidence": w.claim_evidence,
            "takenDown": bool(w.taken_down), "createdAt": w.created_at, "updatedAt": w.updated_at,
            "owner": {"id": owner.id, "name": owner.name, "orcid": owner.orcid, "affiliation": owner.affiliation} if owner else None,
            "org": {"id": org.id, "name": org.name, "verified": bool(org.verified)} if org else None,
            "latestVersion": self._version_dict(latest) if latest else None,
        }

    @staticmethod
    def _version_dict(v: sa.Row) -> dict:
        return {"id": v.id, "version": v.version, "filename": v.filename, "contentType": v.content_type, "size": v.size,
                "sha256": v.sha256, "note": v.note, "createdAt": v.created_at}

    def get_work(self, work_id: str, viewer: Optional[sa.Row]) -> dict:
        with self.engine.connect() as conn:
            work, access = self._visible(conn, work_id, viewer)
            out = self._work_summary(conn, work)
            out["versions"] = [self._version_dict(v) for v in conn.execute(
                sa.select(work_versions).where(work_versions.c.work_id == work_id).order_by(work_versions.c.version.desc())).all()]
            out["ownership"] = [
                {"id": r.id, "event": r.event, "versionId": r.version_id, "orcid": r.orcid, "sha256": r.sha256,
                 "size": r.size, "filename": r.filename, "createdAt": r.created_at, "recordHash": r.record_hash,
                 "prevHash": r.prev_hash, "seq": r.seq}
                for r in conn.execute(sa.select(ownership_records).where(ownership_records.c.work_id == work_id)
                                      .order_by(ownership_records.c.seq)).all()
            ]
            if work.taken_down:
                out["takedownReason"] = work.takedown_reason or ""
            pending = None
            if viewer is not None and access != "owner":
                pending = conn.execute(sa.select(access_requests.c.id, access_requests.c.kind).where(
                    access_requests.c.work_id == work_id, access_requests.c.requester_id == viewer.id,
                    access_requests.c.status == "pending")).all()
            out["viewer"] = {
                "signedIn": viewer is not None, "access": access, "isOwner": access == "owner",
                "canDownload": access in ("owner", "admin", "granted", "open"),
                "pendingRequests": [{"id": p.id, "kind": p.kind} for p in pending or []],
            }
            if access == "owner":
                out["grants"] = [
                    {"id": r.id, "name": r.name, "orcid": r.orcid, "grantedAt": r.granted_at}
                    for r in conn.execute(sa.select(users.c.id, users.c.name, users.c.orcid, work_access.c.granted_at)
                                          .join(work_access, work_access.c.user_id == users.c.id)
                                          .where(work_access.c.work_id == work_id)).all()
                ]
            return out

    # ------------------------------------------------------------------ discovery
    @staticmethod
    def _listed() -> sa.ColumnElement:
        return sa.and_(works.c.visibility.in_(("open", "request")), works.c.taken_down.is_(False))

    @staticmethod
    def _text_match(token: str) -> sa.ColumnElement:
        like = f"%{token.replace('%', '').replace('_', '')}%"
        return sa.or_(*(sa.func.lower(c).like(like) for c in (works.c.title, works.c.abstract, works.c.tags_json, works.c.authors_json)))

    def discover(self, q: str = "", tag: str = "", limit: int = 20, offset: int = 0) -> dict:
        where = [self._listed()]
        where += [self._text_match(t) for t in _tokens(q, 8)]
        if tag.strip():
            where.append(sa.func.lower(works.c.tags_json).like(f'%"{tag.strip().lower()}"%'))
        with self.engine.connect() as conn:
            total = conn.execute(sa.select(sa.func.count()).select_from(works).where(*where)).scalar_one()
            rows = conn.execute(sa.select(works).where(*where).order_by(works.c.updated_at.desc())
                                .limit(max(1, min(limit, 50))).offset(max(0, offset))).all()
            return {"total": total, "items": [self._work_summary(conn, w) for w in rows]}

    def related(self, text: str, limit: int = 5) -> list[dict]:
        """Listed works sharing the most keywords with a research question, for the report view."""
        keywords = _tokens(text, 6)
        if not keywords:
            return []
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(works).where(self._listed(), sa.or_(*(self._text_match(k) for k in keywords)))
                                .order_by(works.c.updated_at.desc()).limit(60)).all()

            def score(w: sa.Row) -> int:
                hay = f"{w.title} {w.abstract} {w.tags_json}".lower()
                return sum(k in hay for k in keywords)

            ranked = sorted(rows, key=score, reverse=True)[:limit]
            return [self._work_summary(conn, w) for w in ranked]

    def my_works(self, uid: str) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(works).where(works.c.owner_id == uid).order_by(works.c.updated_at.desc())).all()
            return [self._work_summary(conn, w) for w in rows]

    def shared_with_me(self, uid: str) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(works).join(work_access, work_access.c.work_id == works.c.id)
                                .where(work_access.c.user_id == uid, works.c.taken_down.is_(False))
                                .order_by(works.c.updated_at.desc())).all()
            return [self._work_summary(conn, w) for w in rows]

    # ------------------------------------------------------------------ publishing
    def _clean_meta(self, conn: sa.Connection, uid: str, body: dict, creating: bool) -> dict:
        out: dict = {}
        if creating or body.get("title") is not None:
            title = str(body.get("title") or "").strip()
            if not title:
                raise Invalid("A work needs a title.")
            out["title"] = title[:300]
        if body.get("abstract") is not None:
            out["abstract"] = str(body["abstract"]).strip()[:5000]
        if body.get("authors") is not None:
            authors = [str(a).strip()[:200] for a in body["authors"] if str(a).strip()][:50]
            if not authors:
                raise Invalid("List at least one author.")
            out["authors_json"] = json.dumps(authors)
        if body.get("tags") is not None:
            tags: list[str] = []
            for t in body["tags"]:
                t = re.sub(r"\s+", " ", str(t).strip().lower())[:40]
                if t and t not in tags:
                    tags.append(t)
            out["tags_json"] = json.dumps(tags[:10])
        if creating or body.get("license") is not None:
            if body.get("license") not in LICENSES:
                raise Invalid("Choose a license: CC BY, CC BY-NC, CC0 or All rights reserved.")
            out["license"] = body["license"]
        if "orgId" in body:
            org_id = body.get("orgId") or None
            if org_id and not conn.execute(sa.select(org_members.c.user_id).where(
                    org_members.c.org_id == org_id, org_members.c.user_id == uid)).first():
                raise Invalid("You can only publish for organizations you belong to.")
            out["org_id"] = org_id
        return out

    def _append_record(self, conn: sa.Connection, *, event: str, work_id: str, version_id: Optional[str], user_id: str,
                       sha256: str, size: int, filename: str) -> None:
        if conn.dialect.name == "postgresql":
            # Serializes appends across server instances, so the chain never forks
            conn.execute(sa.text("SELECT pg_advisory_xact_lock(727274)"))
        prev = conn.execute(sa.select(ownership_records.c.record_hash).order_by(ownership_records.c.seq.desc()).limit(1)).scalar()
        orcid = conn.execute(sa.select(users.c.orcid).where(users.c.id == user_id)).scalar()
        record = {"id": new_id("own"), "event": event, "work_id": work_id, "version_id": version_id, "user_id": user_id,
                  "orcid": orcid, "sha256": sha256, "size": size, "filename": filename[:200], "created_at": now_ms(),
                  "prev_hash": prev or GENESIS}
        conn.execute(ownership_records.insert().values(**record, record_hash=_record_hash(record)))

    def _add_version(self, conn: sa.Connection, uid: str, work_id: str, data: bytes, filename: str, content_type: str,
                     note: str, ext: str) -> dict:
        vid = new_id("ver")
        number = (conn.execute(sa.select(sa.func.max(work_versions.c.version)).where(work_versions.c.work_id == work_id)).scalar() or 0) + 1
        digest = hashlib.sha256(data).hexdigest()
        key = f"works/{work_id}/{vid}.{ext}"
        self.blobs.put(key, data, content_type)
        values = {"id": vid, "work_id": work_id, "version": number, "blob_key": key, "filename": filename[:200],
                  "content_type": content_type, "size": len(data), "sha256": digest, "note": note.strip()[:500],
                  "created_by": uid, "created_at": now_ms()}
        conn.execute(work_versions.insert().values(**values))
        self._append_record(conn, event="upload", work_id=work_id, version_id=vid, user_id=uid, sha256=digest,
                            size=len(data), filename=filename)
        conn.execute(works.update().where(works.c.id == work_id).values(updated_at=now_ms()))
        return values

    def create_work(self, user: sa.Row, body: dict) -> dict:
        if not user.orcid:
            raise Forbidden("Connect your ORCID iD before publishing.")
        wid = new_id("work")
        with self._chain_lock, self.engine.begin() as conn:
            meta = self._clean_meta(conn, user.id, body, creating=True)
            meta.setdefault("authors_json", json.dumps([user.name]))
            consume(conn, user.id, "publish", settings.limit_uploads_per_day, "new works")
            now = now_ms()
            conn.execute(works.insert().values(id=wid, owner_id=user.id, visibility="private", claimed=False,
                                               taken_down=False, created_at=now, updated_at=now, **meta))
            report_id = body.get("reportId")
            if report_id:
                # Publishing a NemoSearch report snapshots its text as the first version
                row = conn.execute(sa.select(reports).where(reports.c.id == report_id, reports.c.deleted.is_(False))).first()
                if row is None or row.owner_id != user.id:
                    raise Invalid("You can only publish research you ran yourself.")
                slug = re.sub(r"[^a-z0-9]+", "-", row.title.lower()).strip("-")[:60] or "report"
                self._add_version(conn, user.id, wid, row.report_text.encode(), f"{slug}.md", "text/markdown; charset=utf-8",
                                  "Published from a NemoSearch report", "md")
        return self.get_work(wid, user)

    def add_version(self, user: sa.Row, work_id: str, data: bytes, filename: str, note: str) -> dict:
        if not data.startswith(b"%PDF-"):
            raise Invalid("Upload a PDF file.")
        if len(data) > settings.max_work_bytes:
            raise Invalid(f"Files can be up to {settings.max_work_bytes // (1024 * 1024)} MB.")
        with self._chain_lock, self.engine.begin() as conn:
            work = self._owned(conn, work_id, user.id)
            if work.claimed:
                raise Invalid("Claimed works link to the original publication and can't hold uploads.")
            consume(conn, user.id, "upload", settings.limit_uploads_per_day, "uploads")
            name = re.sub(r"[\\/]", "_", filename).strip() or "work.pdf"
            self._add_version(conn, user.id, work_id, data, name if name.lower().endswith(".pdf") else f"{name}.pdf",
                              "application/pdf", note, "pdf")
        return self.get_work(work_id, user)

    def update_work(self, user: sa.Row, work_id: str, body: dict) -> dict:
        with self.engine.begin() as conn:
            work = self._owned(conn, work_id, user.id)
            fields = self._clean_meta(conn, user.id, body, creating=False)
            if work.claimed:
                fields.pop("license", None)
            visibility = body.get("visibility")
            if visibility is not None:
                if visibility not in VISIBILITIES:
                    raise Invalid("Visibility must be private, request or open.")
                fields["visibility"] = visibility
            target = fields.get("visibility", work.visibility)
            if target != "private":
                if work.taken_down:
                    raise Invalid("This work was taken down and can't be shared until an admin restores it.")
                has_content = work.external_url or conn.execute(
                    sa.select(work_versions.c.id).where(work_versions.c.work_id == work_id).limit(1)).first()
                if not has_content:
                    raise Invalid("Upload a file before sharing this work.")
                # Sharing, or changing the terms of something already shared, needs the owner's explicit confirmation
                if (target != work.visibility or "license" in fields) and body.get("confirmRights") is not True:
                    raise Invalid("Confirm that you hold the rights to share this work under the chosen license.")
            if fields:
                conn.execute(works.update().where(works.c.id == work_id).values(**fields, updated_at=now_ms()))
        return self.get_work(work_id, user)

    def delete_work(self, uid: str, work_id: str) -> None:
        with self.engine.begin() as conn:
            self._owned(conn, work_id, uid)
            keys = conn.execute(sa.select(work_versions.c.blob_key).where(work_versions.c.work_id == work_id)).scalars().all()
            conn.execute(works.delete().where(works.c.id == work_id))
        for key in keys:
            self.blobs.delete(key)

    def download_link(self, work_id: str, version_id: str, viewer: Optional[sa.Row]) -> str:
        with self.engine.connect() as conn:
            _, access = self._visible(conn, work_id, viewer)
            if access not in ("owner", "admin", "granted", "open"):
                raise Forbidden("Request access to read this work.")
            v = conn.execute(sa.select(work_versions).where(work_versions.c.id == version_id,
                                                           work_versions.c.work_id == work_id)).first()
            if v is None:
                raise NotFound(version_id)
        return self.blobs.download_url(v.blob_key, v.filename, v.content_type)

    def verify_chain(self) -> dict:
        prev, count = GENESIS, 0
        with self.engine.connect() as conn:
            for r in conn.execute(sa.select(ownership_records).order_by(ownership_records.c.seq)):
                record = dict(r._mapping)
                if record["prev_hash"] != prev or _record_hash(record) != record["record_hash"]:
                    return {"ok": False, "records": count, "brokenAt": record["id"]}
                prev, count = record["record_hash"], count + 1
        return {"ok": True, "records": count, "head": prev}

    # ------------------------------------------------------------------ invitations
    def grant(self, uid: str, work_id: str, orcid: str) -> dict:
        orcid = normalize_orcid(orcid)
        emails: list = []
        with self.engine.begin() as conn:
            work = self._owned(conn, work_id, uid)
            target = conn.execute(sa.select(users.c.id).where(users.c.orcid == orcid)).scalar()
            if target is None:
                raise Invalid("Nobody with that ORCID iD has a NemoSearch account yet.")
            if target == uid:
                raise Invalid("You already own this work.")
            self._grant_conn(conn, work_id, target, uid)
            emails = notify.add(conn, target, "access_granted", {"work_id": work_id, "work_title": work.title})
        notify.send(emails)
        return self.get_work(work_id, self._user(uid))

    @staticmethod
    def _grant_conn(conn: sa.Connection, work_id: str, user_id: str, by: str) -> None:
        if not conn.execute(sa.select(work_access.c.user_id).where(
                work_access.c.work_id == work_id, work_access.c.user_id == user_id)).first():
            conn.execute(work_access.insert().values(work_id=work_id, user_id=user_id, granted_by=by, granted_at=now_ms()))

    def revoke(self, uid: str, work_id: str, user_id: str) -> None:
        with self.engine.begin() as conn:
            self._owned(conn, work_id, uid)
            conn.execute(work_access.delete().where(work_access.c.work_id == work_id, work_access.c.user_id == user_id))

    def _user(self, uid: str) -> sa.Row:
        with self.engine.connect() as conn:
            return conn.execute(sa.select(users).where(users.c.id == uid)).one()

    # ------------------------------------------------------------------ requests
    def create_request(self, user: sa.Row, work_id: str, kind: str, message: str) -> dict:
        if kind not in ("access", "collaborate"):
            raise Invalid("A request is for access or for collaboration.")
        emails: list = []
        with self.engine.begin() as conn:
            work, access = self._visible(conn, work_id, user)
            if work.owner_id == user.id:
                raise Invalid("This is your own work.")
            if kind == "access":
                if access in ("granted", "open", "admin"):
                    raise Invalid("You can already read this work.")
                if work.visibility != "request":
                    raise Invalid("This work doesn't take access requests.")
            if conn.execute(sa.select(blocks.c.blocker_id).where(
                    blocks.c.blocker_id == work.owner_id, blocks.c.blocked_id == user.id)).first():
                raise Forbidden("You can't send requests to this researcher.")
            if conn.execute(sa.select(access_requests.c.id).where(
                    access_requests.c.work_id == work_id, access_requests.c.requester_id == user.id,
                    access_requests.c.kind == kind, access_requests.c.status == "pending")).first():
                raise Conflict("You already have a pending request for this work.")
            waiting = conn.execute(
                sa.select(sa.func.count()).select_from(access_requests).join(works, works.c.id == access_requests.c.work_id)
                .where(works.c.owner_id == work.owner_id, access_requests.c.requester_id == user.id,
                       access_requests.c.status == "pending")).scalar_one()
            if waiting >= 3:
                raise Conflict("You have 3 requests waiting with this researcher. Wait for a reply before sending more.")
            consume(conn, user.id, "request", settings.limit_requests_per_day, "requests")
            rid = new_id("req")
            conn.execute(access_requests.insert().values(
                id=rid, work_id=work_id, requester_id=user.id, kind=kind, message=(message or "").strip()[:1000],
                status="pending", response="", created_at=now_ms(),
            ))
            emails = notify.add(conn, work.owner_id, "request_received",
                                {"request_id": rid, "work_id": work_id, "work_title": work.title, "kind": kind, "from": user.name})
        notify.send(emails)
        return self._request(rid, user.id)

    def _request(self, rid: str, uid: str) -> dict:
        with self.engine.connect() as conn:
            return self._request_dicts(conn, sa.select(access_requests).where(access_requests.c.id == rid), uid)[0]

    @staticmethod
    def _request_dicts(conn: sa.Connection, q: sa.Select, uid: str) -> list[dict]:
        out = []
        for r in conn.execute(q.order_by(access_requests.c.created_at.desc())).all():
            work = conn.execute(sa.select(works.c.id, works.c.title, works.c.owner_id).where(works.c.id == r.work_id)).first()
            requester = conn.execute(sa.select(users).where(users.c.id == r.requester_id)).first()
            out.append({
                "id": r.id, "kind": r.kind, "message": r.message, "status": r.status, "response": r.response,
                "projectId": r.project_id, "createdAt": r.created_at, "decidedAt": r.decided_at,
                "work": {"id": work.id, "title": work.title} if work else None,
                "requester": public_user(requester) if requester else None,
                "incoming": bool(work and work.owner_id == uid),
            })
        return out

    def list_requests(self, uid: str, box: str) -> list[dict]:
        with self.engine.connect() as conn:
            if box == "incoming":
                q = sa.select(access_requests).join(works, works.c.id == access_requests.c.work_id).where(works.c.owner_id == uid)
            else:
                q = sa.select(access_requests).where(access_requests.c.requester_id == uid)
            return self._request_dicts(conn, q.limit(200), uid)

    def decide(self, uid: str, rid: str, accept: bool, response: str, project_id: Optional[str]) -> dict:
        emails: list = []
        with self.engine.begin() as conn:
            req = conn.execute(sa.select(access_requests).where(access_requests.c.id == rid)).first()
            work = self._work(conn, req.work_id) if req else None
            if req is None or work.owner_id != uid:
                raise NotFound(rid)
            if req.status != "pending":
                raise Conflict("This request was already answered or withdrawn.")
            values = {"status": "accepted" if accept else "declined", "response": (response or "").strip()[:1000],
                      "decided_at": now_ms()}
            if accept:
                self._grant_conn(conn, work.id, req.requester_id, uid)
                if req.kind == "collaborate":
                    # Collaboration happens in a shared project: an existing one of the owner's, or a new one
                    if project_id:
                        if conn.execute(sa.select(projects.c.owner_id).where(projects.c.id == project_id)).scalar() != uid:
                            raise Invalid("Choose one of your own projects to share.")
                        pid = project_id
                    else:
                        pid, now = new_id("project"), now_ms()
                        conn.execute(projects.insert().values(
                            id=pid, owner_id=uid, name=f"Collaboration: {work.title}"[:120],
                            description=f"Shared through NemoSearch Network for “{work.title}”."[:500],
                            notes="", archived=False, created_at=now, updated_at=now,
                        ))
                    Store.add_member_conn(conn, pid, req.requester_id, uid)
                    values["project_id"] = pid
            conn.execute(access_requests.update().where(access_requests.c.id == rid).values(**values))
            emails = notify.add(conn, req.requester_id, "request_accepted" if accept else "request_declined",
                                {"request_id": rid, "work_id": work.id, "work_title": work.title, "kind": req.kind,
                                 "project_id": values.get("project_id")})
        notify.send(emails)
        return self._request(rid, uid)

    def withdraw(self, uid: str, rid: str) -> dict:
        with self.engine.begin() as conn:
            req = conn.execute(sa.select(access_requests).where(access_requests.c.id == rid)).first()
            if req is None or req.requester_id != uid:
                raise NotFound(rid)
            if req.status != "pending":
                raise Conflict("This request was already answered.")
            conn.execute(access_requests.update().where(access_requests.c.id == rid).values(status="withdrawn", decided_at=now_ms()))
        return self._request(rid, uid)

    # ------------------------------------------------------------------ notifications
    def notifications(self, uid: str) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(notifications).where(notifications.c.user_id == uid)
                                .order_by(notifications.c.created_at.desc()).limit(50)).all()
        return [{"id": r.id, "kind": r.kind, "data": json.loads(r.data_json), "read": bool(r.read), "createdAt": r.created_at} for r in rows]

    def mark_read(self, uid: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(notifications.update().where(notifications.c.user_id == uid).values(read=True))

    # ------------------------------------------------------------------ people
    def person(self, person_id: str, viewer: Optional[sa.Row]) -> dict:
        with self.engine.connect() as conn:
            row = conn.execute(sa.select(users).where(users.c.id == person_id)).first()
            if row is None:
                raise NotFound(person_id)
            q = sa.select(works).where(works.c.owner_id == person_id)
            if viewer is None or viewer.id != person_id:
                q = q.where(self._listed())
            listed = conn.execute(q.order_by(works.c.updated_at.desc())).all()
            orgs = conn.execute(sa.select(organizations.c.id, organizations.c.name, organizations.c.verified)
                                .join(org_members, org_members.c.org_id == organizations.c.id)
                                .where(org_members.c.user_id == person_id)).all()
            blocked = bool(viewer and conn.execute(sa.select(blocks.c.blocker_id).where(
                blocks.c.blocker_id == viewer.id, blocks.c.blocked_id == person_id)).first())
            return {**public_user(row), "works": [self._work_summary(conn, w) for w in listed],
                    "organizations": [{"id": o.id, "name": o.name, "verified": bool(o.verified)} for o in orgs],
                    "blockedByYou": blocked, "isYou": bool(viewer and viewer.id == person_id)}

    def search_people(self, q: str) -> list[dict]:
        tokens = (_tokens(q, 5) or [q.strip().lower()]) if q.strip() else []
        if not tokens:
            return []
        conds = [sa.or_(*(sa.func.lower(c).like(f"%{t}%") for c in (users.c.name, users.c.affiliation, users.c.interests_json, users.c.orcid)))
                 for t in tokens]
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(users).where(*conds).order_by(users.c.name).limit(20)).all()
        return [public_user(r) for r in rows]

    def block(self, uid: str, target: str, on: bool) -> None:
        if target == uid:
            raise Invalid("You can't block yourself.")
        with self.engine.begin() as conn:
            if conn.execute(sa.select(users.c.id).where(users.c.id == target)).first() is None:
                raise NotFound(target)
            conn.execute(blocks.delete().where(blocks.c.blocker_id == uid, blocks.c.blocked_id == target))
            if on:
                conn.execute(blocks.insert().values(blocker_id=uid, blocked_id=target, created_at=now_ms()))
                # Their pending requests to you are declined quietly
                mine = sa.select(works.c.id).where(works.c.owner_id == uid)
                conn.execute(access_requests.update().where(
                    access_requests.c.requester_id == target, access_requests.c.status == "pending",
                    access_requests.c.work_id.in_(mine)).values(status="declined", decided_at=now_ms()))

    # ------------------------------------------------------------------ organizations
    def _org_dict(self, conn: sa.Connection, org: sa.Row, viewer: Optional[sa.Row]) -> dict:
        members = conn.execute(sa.select(users, org_members.c.role).join(org_members, org_members.c.user_id == users.c.id)
                               .where(org_members.c.org_id == org.id).order_by(org_members.c.added_at)).all()
        listed = conn.execute(sa.select(works).where(works.c.org_id == org.id, self._listed())
                              .order_by(works.c.updated_at.desc()).limit(100)).all()
        my_role = next((m.role for m in members if viewer and m.id == viewer.id), None)
        return {"id": org.id, "name": org.name, "rorId": org.ror_id, "website": org.website, "description": org.description,
                "verified": bool(org.verified), "createdAt": org.created_at, "yourRole": my_role,
                "members": [{**public_user(m), "role": m.role} for m in members],
                "works": [self._work_summary(conn, w) for w in listed]}

    def get_org(self, org_id: str, viewer: Optional[sa.Row]) -> dict:
        with self.engine.connect() as conn:
            org = conn.execute(sa.select(organizations).where(organizations.c.id == org_id)).first()
            if org is None:
                raise NotFound(org_id)
            return self._org_dict(conn, org, viewer)

    def _clean_org(self, body: dict, creating: bool) -> dict:
        out: dict = {}
        if creating or body.get("name") is not None:
            name = str(body.get("name") or "").strip()
            if not name:
                raise Invalid("An organization needs a name.")
            out["name"] = name[:200]
        if body.get("rorId") is not None:
            ror = re.sub(r"^https?://ror\.org/", "", str(body["rorId"]).strip().lower())
            if ror and not ROR_RE.match(ror):
                raise Invalid("That isn't a valid ROR id. Find yours at ror.org; it looks like 05m7pjf47.")
            out["ror_id"] = ror or None
        if body.get("website") is not None:
            site = str(body["website"]).strip()[:300]
            if site and not site.startswith(("https://", "http://")):
                raise Invalid("The website should start with https://")
            out["website"] = site
        if body.get("description") is not None:
            out["description"] = str(body["description"]).strip()[:2000]
        return out

    def create_org(self, uid: str, body: dict) -> dict:
        oid = new_id("org")
        with self.engine.begin() as conn:
            values = self._clean_org(body, creating=True)
            if values.get("ror_id") and conn.execute(sa.select(organizations.c.id).where(organizations.c.ror_id == values["ror_id"])).first():
                raise Conflict("An organization with that ROR id already exists. Ask one of its admins to add you.")
            consume(conn, uid, "org", 5, "new organizations")
            conn.execute(organizations.insert().values(id=oid, verified=False, created_by=uid, created_at=now_ms(), **values))
            conn.execute(org_members.insert().values(org_id=oid, user_id=uid, role="admin", added_at=now_ms()))
        return self.get_org(oid, self._user(uid))

    def _org_admin(self, conn: sa.Connection, uid: str, org_id: str) -> None:
        role = conn.execute(sa.select(org_members.c.role).where(org_members.c.org_id == org_id, org_members.c.user_id == uid)).scalar()
        if role is None:
            if conn.execute(sa.select(organizations.c.id).where(organizations.c.id == org_id)).first() is None:
                raise NotFound(org_id)
            raise Forbidden("Only the organization's admins can do that.")
        if role != "admin":
            raise Forbidden("Only the organization's admins can do that.")

    def update_org(self, uid: str, org_id: str, body: dict) -> dict:
        with self.engine.begin() as conn:
            self._org_admin(conn, uid, org_id)
            values = self._clean_org(body, creating=False)
            if "name" in values or "ror_id" in values:
                values["verified"] = False  # a verified badge applies to the identity an admin checked
            if values:
                conn.execute(organizations.update().where(organizations.c.id == org_id).values(**values))
        return self.get_org(org_id, self._user(uid))

    def add_org_member(self, uid: str, org_id: str, orcid: str, role: str) -> dict:
        orcid = normalize_orcid(orcid)
        if role not in ("admin", "member"):
            raise Invalid("Role must be admin or member.")
        with self.engine.begin() as conn:
            self._org_admin(conn, uid, org_id)
            target = conn.execute(sa.select(users.c.id).where(users.c.orcid == orcid)).scalar()
            if target is None:
                raise Invalid("Nobody with that ORCID iD has a NemoSearch account yet.")
            conn.execute(org_members.delete().where(org_members.c.org_id == org_id, org_members.c.user_id == target))
            conn.execute(org_members.insert().values(org_id=org_id, user_id=target, role=role, added_at=now_ms()))
        return self.get_org(org_id, self._user(uid))

    def remove_org_member(self, uid: str, org_id: str, member_id: str) -> dict:
        with self.engine.begin() as conn:
            if member_id != uid:
                self._org_admin(conn, uid, org_id)
            admins = conn.execute(sa.select(org_members.c.user_id).where(
                org_members.c.org_id == org_id, org_members.c.role == "admin")).scalars().all()
            if admins == [member_id]:
                raise Invalid("An organization needs at least one admin. Make someone else an admin first.")
            if not conn.execute(org_members.delete().where(org_members.c.org_id == org_id, org_members.c.user_id == member_id)).rowcount:
                raise NotFound(member_id)
        return self.get_org(org_id, self._user(uid))

    # ------------------------------------------------------------------ claims (works published elsewhere)
    async def _openalex_work(self, doi: str) -> Optional[dict]:
        key = os.getenv("OPENALEX_API_KEY", "").strip()
        try:
            r = await self.http.get(f"https://api.openalex.org/works/doi:{doi}", params={"api_key": key} if key else {})
        except httpx.HTTPError:
            return None
        return r.json() if r.status_code == 200 else None

    async def _orcid_record_entry(self, orcid: str, doi: str) -> Optional[dict]:
        """The work summary on the claimant's public ORCID record whose own DOI matches, if any."""
        api = settings.orcid_base.replace("://", "://pub.", 1)
        try:
            r = await self.http.get(f"{api}/v3.0/{orcid}/works", headers={"Accept": "application/json"})
        except httpx.HTTPError as e:
            raise Invalid(f"ORCID couldn't be reached ({e.__class__.__name__}). Try again in a minute.") from e
        if r.status_code != 200:
            return None
        for group in r.json().get("group") or []:
            for summary in group.get("work-summary") or []:
                ids = ((summary.get("external-ids") or {}).get("external-id")) or []
                if any(i.get("external-id-type") == "doi" and i.get("external-id-relationship", "self") == "self"
                       and str(i.get("external-id-value") or "").strip().lower() == doi for i in ids):
                    return summary
        return None

    @staticmethod
    def _orcid_evidence(summary: dict, orcid: str) -> str:
        """Says who put the work on the record: the researcher (self-asserted) or a third party such as Crossref."""
        source = summary.get("source") or {}
        tool = ((source.get("source-name") or {}).get("value")) or ""
        by_owner = orcid in {(source.get("source-orcid") or {}).get("path"), (source.get("assertion-origin-orcid") or {}).get("path")}
        if by_owner:
            how = "added by the researcher" + (f" using {tool}" if source.get("source-client-id") and tool else "")
        else:
            how = f"added by {tool}" if tool else "added by a third party"
        return f"Listed on the claimant's ORCID record ({how})."

    async def claim(self, user: sa.Row, doi: str) -> dict:
        """Lists a paper published elsewhere on the claimant's profile, linking to the original. Allowed when OpenAlex
        lists the claimant's ORCID iD among the paper's authors, or when the paper is on the claimant's own public
        ORCID record (which they proved they control by signing in with it)."""
        doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", (doi or "").strip(), flags=re.I).lower()
        if not re.match(r"^10\.\d{4,9}/\S+$", doi):
            raise Invalid("Enter a DOI, like 10.48550/arXiv.2101.03961.")
        if not user.orcid:
            raise Forbidden("Connect your ORCID iD before claiming works.")
        item = await self._openalex_work(doi)
        orcids = {str((a.get("author") or {}).get("orcid") or "").rsplit("/", 1)[-1] for a in (item or {}).get("authorships") or []}
        if item and user.orcid in orcids:
            return await run_in_threadpool(self._create_claim, user, doi, item, "OpenAlex lists the claimant's ORCID iD among the authors.")
        summary = await self._orcid_record_entry(user.orcid, doi)
        if summary is None:
            raise Invalid("This DOI isn't on your public ORCID record, and OpenAlex doesn't link your ORCID iD to it, so "
                          "it can't be claimed. Add the work to your ORCID record with visibility set to Everyone, then try again.")
        if item is None:  # OpenAlex doesn't know the DOI: list it from the ORCID record
            item = {"display_name": ((summary.get("title") or {}).get("title") or {}).get("value") or doi,
                    "authorships": [{"author": {"display_name": user.name}}]}
        return await run_in_threadpool(self._create_claim, user, doi, item, self._orcid_evidence(summary, user.orcid))

    def _create_claim(self, user: sa.Row, doi: str, item: dict, evidence: str) -> dict:
        wid = new_id("work")
        with self._chain_lock, self.engine.begin() as conn:
            if conn.execute(sa.select(works.c.id).where(works.c.doi == doi, works.c.claimed.is_(True),
                                                       works.c.owner_id == user.id)).first():
                raise Conflict("You've already claimed this work.")
            consume(conn, user.id, "publish", settings.limit_uploads_per_day, "new works")
            authors = [(a.get("author") or {}).get("display_name") or a.get("raw_author_name") or ""
                       for a in item.get("authorships") or []]
            topic = ((item.get("primary_topic") or {}).get("display_name") or "").lower()
            landing = ((item.get("primary_location") or {}).get("landing_page_url")) or f"https://doi.org/{doi}"
            now = now_ms()
            conn.execute(works.insert().values(
                id=wid, owner_id=user.id, title=str(item.get("display_name") or doi)[:300],
                abstract=_abstract(item.get("abstract_inverted_index"))[:5000],
                authors_json=json.dumps([a for a in authors if a][:50]), tags_json=json.dumps([topic] if topic else []),
                license="external", visibility="open", external_url=landing, doi=doi, claimed=True, claim_evidence=evidence,
                taken_down=False, created_at=now, updated_at=now,
            ))
            fingerprint = hashlib.sha256(json.dumps({"doi": doi, "openalex": item.get("id"), "evidence": evidence},
                                                    sort_keys=True).encode()).hexdigest()
            self._append_record(conn, event="claim", work_id=wid, version_id=None, user_id=user.id, sha256=fingerprint,
                                size=0, filename=f"doi:{doi}")
        return self.get_work(wid, user)

    # ------------------------------------------------------------------ abuse and admin
    def report_abuse(self, uid: str, target_kind: str, target_id: str, reason: str, details: str) -> None:
        if target_kind not in ("work", "user") or reason not in ABUSE_REASONS:
            raise Invalid("Choose what you're reporting and why.")
        with self.engine.begin() as conn:
            table = works if target_kind == "work" else users
            if conn.execute(sa.select(table.c.id).where(table.c.id == target_id)).first() is None:
                raise NotFound(target_id)
            consume(conn, uid, "abuse", 20, "reports")
            conn.execute(abuse_reports.insert().values(
                id=new_id("abuse"), reporter_id=uid, target_kind=target_kind, target_id=target_id, reason=reason,
                details=(details or "").strip()[:2000], status="open", resolution="", created_at=now_ms(),
            ))

    @staticmethod
    def _need_admin(user: sa.Row) -> None:
        if not user.is_admin:
            raise NotFound("admin")

    def admin_reports(self, user: sa.Row, status: str) -> list[dict]:
        self._need_admin(user)
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(abuse_reports).where(abuse_reports.c.status == status)
                                .order_by(abuse_reports.c.created_at.desc()).limit(200)).all()
            out = []
            for r in rows:
                title = (conn.execute(sa.select(works.c.title).where(works.c.id == r.target_id)).scalar()
                         if r.target_kind == "work" else conn.execute(sa.select(users.c.name).where(users.c.id == r.target_id)).scalar())
                out.append({"id": r.id, "targetKind": r.target_kind, "targetId": r.target_id, "targetTitle": title or "(deleted)",
                            "reason": r.reason, "details": r.details, "status": r.status, "resolution": r.resolution,
                            "createdAt": r.created_at})
            return out

    def admin_resolve(self, user: sa.Row, report_id: str, resolution: str) -> None:
        self._need_admin(user)
        with self.engine.begin() as conn:
            if not conn.execute(abuse_reports.update().where(abuse_reports.c.id == report_id).values(
                    status="resolved", resolution=(resolution or "").strip()[:1000], resolved_by=user.id)).rowcount:
                raise NotFound(report_id)

    def admin_takedown(self, user: sa.Row, work_id: str, down: bool, reason: str) -> dict:
        self._need_admin(user)
        emails: list = []
        with self.engine.begin() as conn:
            work = self._work(conn, work_id)
            conn.execute(works.update().where(works.c.id == work_id).values(
                taken_down=down, takedown_reason=(reason or "").strip()[:1000] if down else None))
            if down:
                emails = notify.add(conn, work.owner_id, "work_taken_down",
                                    {"work_id": work_id, "work_title": work.title, "reason": (reason or "").strip()[:300]})
        notify.send(emails)
        return self.get_work(work_id, user)

    def admin_verify_org(self, user: sa.Row, org_id: str, verified: bool) -> dict:
        self._need_admin(user)
        with self.engine.begin() as conn:
            if not conn.execute(organizations.update().where(organizations.c.id == org_id).values(verified=verified)).rowcount:
                raise NotFound(org_id)
        return self.get_org(org_id, user)


# ---------------------------------------------------------------------------- HTTP
class WorkCreate(BaseModel):
    title: str
    abstract: str = ""
    authors: Optional[list[str]] = None
    tags: list[str] = []
    license: str
    orgId: Optional[str] = None
    reportId: Optional[str] = None


class WorkPatch(BaseModel):
    title: Optional[str] = None
    abstract: Optional[str] = None
    authors: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    license: Optional[str] = None
    visibility: Optional[str] = None
    orgId: Optional[str] = None
    confirmRights: bool = False


class OrcidBody(BaseModel):
    orcid: str
    role: str = "member"


class RequestCreate(BaseModel):
    kind: str
    message: str = ""


class Decision(BaseModel):
    response: str = ""
    projectId: Optional[str] = None


class OrgBody(BaseModel):
    name: Optional[str] = None
    rorId: Optional[str] = None
    website: Optional[str] = None
    description: Optional[str] = None


class ClaimBody(BaseModel):
    doi: str


class AbuseBody(BaseModel):
    targetKind: str
    targetId: str
    reason: str
    details: str = ""


class Resolution(BaseModel):
    resolution: str = ""


class Takedown(BaseModel):
    down: bool = True
    reason: str = ""


class Verify(BaseModel):
    verified: bool = True


def build_router(net: Network, accounts: Accounts) -> APIRouter:
    r = APIRouter(prefix="/api/network")
    me = accounts.require_user
    maybe = accounts.optional_user

    # Discovery is readable without an account, so open works can be shared by link
    @r.get("/works")
    def discover(q: str = "", tag: str = "", limit: int = 20, offset: int = 0):
        return net.discover(q, tag, limit, offset)

    @r.get("/related")
    def related(request: Request, q: str = Query("", max_length=500)):
        me(request)
        return net.related(q)

    @r.get("/works/mine")
    def mine(request: Request):
        return net.my_works(me(request).id)

    @r.get("/works/shared")
    def shared(request: Request):
        return net.shared_with_me(me(request).id)

    @r.post("/works", status_code=201)
    def create(request: Request, body: WorkCreate):
        return net.create_work(me(request), body.model_dump(exclude_none=True))

    @r.get("/works/{work_id}")
    def work(request: Request, work_id: str):
        return net.get_work(work_id, maybe(request))

    @r.patch("/works/{work_id}")
    def update(request: Request, work_id: str, body: WorkPatch):
        patch = body.model_dump(exclude_unset=True)
        if "orgId" in patch and patch["orgId"] is None:
            patch["orgId"] = ""
        return net.update_work(me(request), work_id, patch)

    @r.delete("/works/{work_id}")
    def delete(request: Request, work_id: str):
        net.delete_work(me(request).id, work_id)
        return {"ok": True}

    @r.post("/works/{work_id}/versions", status_code=201)
    async def upload(request: Request, work_id: str):
        user = await run_in_threadpool(me, request)
        if int(request.headers.get("content-length") or 0) > settings.max_work_bytes:
            raise Invalid(f"Files can be up to {settings.max_work_bytes // (1024 * 1024)} MB.")
        data = await request.body()
        from urllib.parse import unquote

        return await run_in_threadpool(net.add_version, user, work_id, data, unquote(request.headers.get("x-filename", "work.pdf")),
                                       unquote(request.headers.get("x-version-note", "")))

    @r.get("/works/{work_id}/versions/{version_id}/download")
    def download(request: Request, work_id: str, version_id: str):
        return RedirectResponse(net.download_link(work_id, version_id, maybe(request)), status_code=303)

    @r.post("/works/{work_id}/access")
    def grant(request: Request, work_id: str, body: OrcidBody):
        return net.grant(me(request).id, work_id, body.orcid)

    @r.delete("/works/{work_id}/access/{user_id}")
    def revoke(request: Request, work_id: str, user_id: str):
        net.revoke(me(request).id, work_id, user_id)
        return {"ok": True}

    @r.post("/works/{work_id}/requests", status_code=201)
    def request_create(request: Request, work_id: str, body: RequestCreate):
        return net.create_request(me(request), work_id, body.kind, body.message)

    @r.get("/requests")
    def requests_list(request: Request, box: str = Query("incoming", pattern="^(incoming|outgoing)$")):
        return net.list_requests(me(request).id, box)

    @r.post("/requests/{request_id}/accept")
    def accept(request: Request, request_id: str, body: Decision):
        return net.decide(me(request).id, request_id, True, body.response, body.projectId)

    @r.post("/requests/{request_id}/decline")
    def decline(request: Request, request_id: str, body: Decision):
        return net.decide(me(request).id, request_id, False, body.response, None)

    @r.post("/requests/{request_id}/withdraw")
    def withdraw(request: Request, request_id: str):
        return net.withdraw(me(request).id, request_id)

    @r.get("/notifications")
    def notes(request: Request):
        return net.notifications(me(request).id)

    @r.post("/notifications/read")
    def notes_read(request: Request):
        net.mark_read(me(request).id)
        return {"ok": True}

    @r.get("/people")
    def people(request: Request, q: str = ""):
        me(request)
        return net.search_people(q)

    @r.get("/people/{person_id}")
    def person(request: Request, person_id: str):
        return net.person(person_id, maybe(request))

    @r.post("/people/{person_id}/block")
    def block(request: Request, person_id: str):
        net.block(me(request).id, person_id, True)
        return {"ok": True}

    @r.delete("/people/{person_id}/block")
    def unblock(request: Request, person_id: str):
        net.block(me(request).id, person_id, False)
        return {"ok": True}

    @r.post("/orgs", status_code=201)
    def org_create(request: Request, body: OrgBody):
        return net.create_org(me(request).id, body.model_dump(exclude_none=True))

    @r.get("/orgs/{org_id}")
    def org(request: Request, org_id: str):
        return net.get_org(org_id, maybe(request))

    @r.patch("/orgs/{org_id}")
    def org_update(request: Request, org_id: str, body: OrgBody):
        return net.update_org(me(request).id, org_id, body.model_dump(exclude_none=True))

    @r.post("/orgs/{org_id}/members")
    def org_member_add(request: Request, org_id: str, body: OrcidBody):
        return net.add_org_member(me(request).id, org_id, body.orcid, body.role)

    @r.delete("/orgs/{org_id}/members/{member_id}")
    def org_member_remove(request: Request, org_id: str, member_id: str):
        return net.remove_org_member(me(request).id, org_id, member_id)

    @r.post("/claims", status_code=201)
    async def claim(request: Request, body: ClaimBody):
        return await net.claim(await run_in_threadpool(me, request), body.doi)

    @r.post("/abuse", status_code=201)
    def abuse(request: Request, body: AbuseBody):
        net.report_abuse(me(request).id, body.targetKind, body.targetId, body.reason, body.details)
        return {"ok": True}

    @r.get("/ownership/verify")
    def verify():
        return net.verify_chain()

    @r.get("/admin/abuse")
    def admin_abuse(request: Request, status: str = Query("open", pattern="^(open|resolved)$")):
        return net.admin_reports(me(request), status)

    @r.post("/admin/abuse/{report_id}/resolve")
    def admin_resolve(request: Request, report_id: str, body: Resolution):
        net.admin_resolve(me(request), report_id, body.resolution)
        return {"ok": True}

    @r.post("/admin/works/{work_id}/takedown")
    def admin_takedown(request: Request, work_id: str, body: Takedown):
        return net.admin_takedown(me(request), work_id, body.down, body.reason)

    @r.post("/admin/orgs/{org_id}/verify")
    def admin_verify(request: Request, org_id: str, body: Verify):
        return net.admin_verify_org(me(request), org_id, body.verified)

    return r
