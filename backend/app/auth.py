"""Accounts and sign-in.

ORCID is the only way to sign in, so every account carries a verified ORCID iD: the person proved they control
it at orcid.org. That is identity, not a credential; an ORCID iD says who someone is, not what they wrote.

Sessions are random tokens in an HttpOnly, SameSite=Lax cookie (Secure on https). Only a SHA-256 of the token
is stored, so a copy of the database cannot be used to sign in.

For local testing without ORCID, AUTH_DEV_LOGIN=1 allows signing in as any name and ORCID iD. The server
refuses to start with it unless APP_URL is localhost (see config.py).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
import sqlalchemy as sa
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

from .blobs import BlobStore
from .config import settings
from .db import (
    access_requests, attachments, exports, new_id, notifications, now_ms, org_members, organizations, paper_templates,
    project_members, projects, reports, saved_sources, sessions, users, work_versions, works,
)
from .errors import Invalid, NotFound

log = logging.getLogger("nemosearch.auth")

SESSION_COOKIE = "ns_session"
STATE_COOKIE = "ns_oauth"
ORCID_RE = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")


class Unauthorized(Exception):
    """401: not signed in, or the session expired."""


def orcid_valid(orcid: str) -> bool:
    """Format and ISO 7064 11,2 check digit, as ORCID specifies."""
    if not ORCID_RE.match(orcid or ""):
        return False
    digits = orcid.replace("-", "")
    total = 0
    for d in digits[:-1]:
        total = (total + int(d)) * 2
    check = (12 - total % 11) % 11
    return digits[-1] == ("X" if check == 10 else str(check))


def normalize_orcid(value: str) -> str:
    """Accepts '0000-0002-1825-0097' or 'https://orcid.org/0000-0002-1825-0097'."""
    value = (value or "").strip().upper()
    value = re.sub(r"^HTTPS?://(SANDBOX\.)?ORCID\.ORG/", "", value)
    if not orcid_valid(value):
        raise Invalid("That isn't a valid ORCID iD. It looks like 0000-0002-1825-0097.")
    return value


def _sign(payload: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    sig = hmac.new(settings.secret_key.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def _unsign(value: str) -> Optional[dict]:
    try:
        body, sig = value.rsplit(".", 1)
    except (ValueError, AttributeError):
        return None
    if not hmac.compare_digest(sig, hmac.new(settings.secret_key.encode(), body.encode(), hashlib.sha256).hexdigest()):
        return None
    data = json.loads(base64.urlsafe_b64decode(body))
    return data if data.get("exp", 0) > time.time() else None


def _safe_next(path: Optional[str]) -> str:
    """Only same-site paths, so the sign-in flow cannot be used to redirect people elsewhere."""
    return path if path and path.startswith("/") and not path.startswith("//") and "\\" not in path else "/"


def public_user(row) -> dict:  # noqa: ANN001
    """What anyone may see about an account. Never includes the notification email."""
    return {
        "id": row.id, "name": row.name, "orcid": row.orcid, "affiliation": row.affiliation,
        "bio": row.bio, "interests": json.loads(row.interests_json or "[]"), "createdAt": row.created_at,
    }


class Accounts:
    def __init__(self, engine: sa.Engine, blobs: BlobStore) -> None:
        self.engine = engine
        self.blobs = blobs

    # ------------------------------------------------------------------ sessions
    def start_session(self, response: Response, user_id: str) -> None:
        token = secrets.token_urlsafe(32)
        now = now_ms()
        with self.engine.begin() as conn:
            conn.execute(sessions.insert().values(
                token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=user_id,
                created_at=now, expires_at=now + settings.session_days * 86_400_000,
            ))
            # Expired sessions are cleaned up as people sign in
            conn.execute(sessions.delete().where(sessions.c.expires_at < now))
        response.set_cookie(
            SESSION_COOKIE, token, max_age=settings.session_days * 86_400, httponly=True,
            secure=settings.secure_cookies, samesite="lax", path="/",
        )

    def end_session(self, request: Request, response: Response) -> None:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            with self.engine.begin() as conn:
                conn.execute(sessions.delete().where(sessions.c.token_hash == hashlib.sha256(token.encode()).hexdigest()))
        response.delete_cookie(SESSION_COOKIE, path="/")

    def optional_user(self, request: Request) -> Optional[sa.Row]:
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            return None
        with self.engine.connect() as conn:
            return conn.execute(
                sa.select(users).join(sessions, sessions.c.user_id == users.c.id).where(
                    sessions.c.token_hash == hashlib.sha256(token.encode()).hexdigest(),
                    sessions.c.expires_at > now_ms(),
                )
            ).first()

    def require_user(self, request: Request) -> sa.Row:
        user = self.optional_user(request)
        if user is None:
            raise Unauthorized()
        return user

    # ------------------------------------------------------------------ accounts
    def upsert_orcid_user(self, orcid: str, name: str) -> str:
        with self.engine.begin() as conn:
            row = conn.execute(sa.select(users.c.id).where(users.c.orcid == orcid)).first()
            admin = orcid in settings.admin_orcids
            if row:
                conn.execute(users.update().where(users.c.id == row.id).values(is_admin=admin))
                return row.id
            uid = new_id("user")
            conn.execute(users.insert().values(
                id=uid, name=(name or "").strip()[:200] or f"ORCID {orcid}", orcid=orcid, affiliation="", bio="",
                interests_json="[]", is_admin=admin, created_at=now_ms(),
            ))
            return uid

    def me(self, uid: str) -> dict:
        with self.engine.connect() as conn:
            row = conn.execute(sa.select(users).where(users.c.id == uid)).one()
            orgs = conn.execute(
                sa.select(organizations.c.id, organizations.c.name, organizations.c.verified, org_members.c.role)
                .join(org_members, org_members.c.org_id == organizations.c.id).where(org_members.c.user_id == uid)
            ).all()
            unread = conn.execute(sa.select(sa.func.count()).select_from(notifications).where(
                notifications.c.user_id == uid, notifications.c.read.is_(False))).scalar_one()
            pending = conn.execute(
                sa.select(sa.func.count()).select_from(access_requests).join(works, works.c.id == access_requests.c.work_id)
                .where(works.c.owner_id == uid, access_requests.c.status == "pending")
            ).scalar_one()
        return {
            **public_user(row), "notifyEmail": row.notify_email or "", "isAdmin": bool(row.is_admin),
            "organizations": [{"id": o.id, "name": o.name, "verified": bool(o.verified), "role": o.role} for o in orgs],
            "unreadNotifications": unread, "pendingRequests": pending,
        }

    def update_profile(self, uid: str, patch: dict) -> dict:
        fields: dict = {}
        if patch.get("name") is not None:
            name = str(patch["name"]).strip()
            if not name:
                raise Invalid("Your name can't be empty.")
            fields["name"] = name[:200]
        if patch.get("affiliation") is not None:
            fields["affiliation"] = str(patch["affiliation"]).strip()[:300]
        if patch.get("bio") is not None:
            fields["bio"] = str(patch["bio"]).strip()[:2000]
        if patch.get("interests") is not None:
            tags = [str(t).strip()[:60] for t in patch["interests"] if str(t).strip()][:20]
            fields["interests_json"] = json.dumps(tags)
        if patch.get("notifyEmail") is not None:
            email = str(patch["notifyEmail"]).strip()
            if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
                raise Invalid("That email address doesn't look right.")
            fields["notify_email"] = email[:320] or None
        if fields:
            with self.engine.begin() as conn:
                conn.execute(users.update().where(users.c.id == uid).values(**fields))
        return self.me(uid)

    def export_account(self, uid: str) -> dict:
        """Everything stored about and by this account (GDPR data portability)."""
        def rows(table: sa.Table, *where) -> list[dict]:  # noqa: ANN002
            with self.engine.connect() as conn:
                return [dict(r._mapping) for r in conn.execute(sa.select(table).where(*where)).all()]

        return {
            "exported_at": now_ms(),
            "account": rows(users, users.c.id == uid),
            "projects": rows(projects, projects.c.owner_id == uid),
            "project_memberships": rows(project_members, project_members.c.user_id == uid),
            "reports": rows(reports, reports.c.owner_id == uid),
            "saved_sources": rows(saved_sources, saved_sources.c.owner_id == uid),
            "attachments": rows(attachments, attachments.c.owner_id == uid),
            "exports": rows(exports, exports.c.owner_id == uid),
            "paper_templates": rows(paper_templates, paper_templates.c.owner_id == uid),
            "works": rows(works, works.c.owner_id == uid),
            "requests_sent": rows(access_requests, access_requests.c.requester_id == uid),
            "notifications": rows(notifications, notifications.c.user_id == uid),
        }

    def delete_account(self, uid: str) -> None:
        """Deletes the account and everything it owns, including stored files. Ownership records stay: they are
        the proof of what was uploaded when, and hold only the account id and ORCID iD."""
        with self.engine.begin() as conn:
            owned_projects = sa.select(projects.c.id).where(projects.c.owner_id == uid)
            keys = conn.execute(sa.select(attachments.c.blob_key).where(
                sa.or_(attachments.c.owner_id == uid, attachments.c.project_id.in_(owned_projects)))).scalars().all()
            keys += conn.execute(sa.select(work_versions.c.blob_key).join(works, works.c.id == work_versions.c.work_id)
                                 .where(works.c.owner_id == uid)).scalars().all()
            # Research other people added to this account's projects stays theirs, in their Unassigned
            conn.execute(reports.update().where(reports.c.project_id.in_(owned_projects), reports.c.owner_id != uid)
                         .values(project_id=None))
            if not conn.execute(users.delete().where(users.c.id == uid)).rowcount:
                raise NotFound(uid)
        for key in keys:
            self.blobs.delete(key)


class DevLogin(BaseModel):
    name: str
    orcid: str = ""


class ProfilePatch(BaseModel):
    name: Optional[str] = None
    affiliation: Optional[str] = None
    bio: Optional[str] = None
    interests: Optional[list[str]] = None
    notifyEmail: Optional[str] = None


class DeleteAccount(BaseModel):
    confirm: str


def build_router(accounts: Accounts) -> APIRouter:
    router = APIRouter()
    redirect_uri = f"{settings.app_url}/api/auth/orcid/callback"

    @router.get("/api/auth/config")
    def auth_config():
        return {"orcid": settings.orcid_enabled, "orcidBase": settings.orcid_base,
                "devLogin": settings.dev_login and settings.is_local and not settings.production}

    @router.get("/api/auth/orcid/login")
    def orcid_login(next: str = "/"):  # noqa: A002
        if not settings.orcid_enabled:
            return RedirectResponse("/?auth_error=orcid_not_configured", status_code=303)
        state = secrets.token_urlsafe(24)
        params = {"client_id": settings.orcid_client_id, "response_type": "code", "scope": "/authenticate",
                  "redirect_uri": redirect_uri, "state": state}
        response = RedirectResponse(f"{settings.orcid_base}/oauth/authorize?{urlencode(params)}", status_code=303)
        response.set_cookie(STATE_COOKIE, _sign({"state": state, "next": _safe_next(next), "exp": time.time() + 600}),
                            max_age=600, httponly=True, secure=settings.secure_cookies, samesite="lax", path="/api/auth")
        return response

    @router.get("/api/auth/orcid/callback")
    async def orcid_callback(request: Request, code: str = "", state: str = "", error: str = ""):
        saved = _unsign(request.cookies.get(STATE_COOKIE, ""))
        if error or not code or not saved or not hmac.compare_digest(saved["state"], state):
            return RedirectResponse("/?auth_error=" + ("denied" if error else "expired"), status_code=303)
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.post(f"{settings.orcid_base}/oauth/token", headers={"Accept": "application/json"}, data={
                    "client_id": settings.orcid_client_id, "client_secret": settings.orcid_client_secret,
                    "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
                })
                r.raise_for_status()
                token = r.json()
        except Exception as e:  # noqa: BLE001
            log.warning("ORCID token exchange failed: %s", e)
            return RedirectResponse("/?auth_error=orcid_unavailable", status_code=303)
        orcid = str(token.get("orcid") or "")
        if not orcid_valid(orcid):
            return RedirectResponse("/?auth_error=orcid_unavailable", status_code=303)
        uid = accounts.upsert_orcid_user(orcid, str(token.get("name") or ""))
        response = RedirectResponse(saved["next"], status_code=303)
        response.delete_cookie(STATE_COOKIE, path="/api/auth")
        accounts.start_session(response, uid)
        return response

    @router.post("/api/auth/dev-login")
    def dev_login(request: Request, body: DevLogin):
        # Belt and braces: besides the startup check, only a browser on this machine talking to localhost gets in
        loopback = request.client is not None and request.client.host in {"127.0.0.1", "::1"}
        if not (settings.dev_login and settings.is_local and not settings.production and loopback
                and request.url.hostname in {"localhost", "127.0.0.1"}):
            raise NotFound("dev-login")
        if body.orcid.strip():
            orcid = normalize_orcid(body.orcid)
        else:  # a stable made-up iD per name, with a valid check digit
            base = str(int(hashlib.sha256(body.name.strip().lower().encode()).hexdigest(), 16))[:15].rjust(15, "0")
            orcid = next(o for o in (f"{base[:4]}-{base[4:8]}-{base[8:12]}-{base[12:15]}{c}" for c in "0123456789X") if orcid_valid(o))
        response = JSONResponse({"ok": True})
        accounts.start_session(response, accounts.upsert_orcid_user(orcid, body.name))
        return response

    @router.post("/api/auth/logout")
    def logout(request: Request):
        response = JSONResponse({"ok": True})
        accounts.end_session(request, response)
        return response

    @router.get("/api/me")
    def me(request: Request):
        return accounts.me(accounts.require_user(request).id)

    @router.patch("/api/me")
    def me_update(request: Request, body: ProfilePatch):
        return accounts.update_profile(accounts.require_user(request).id, body.model_dump(exclude_none=True))

    @router.get("/api/me/export")
    def me_export(request: Request):
        data = accounts.export_account(accounts.require_user(request).id)
        return Response(json.dumps(data, indent=2, default=str), media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename="nemosearch-account.json"'})

    @router.delete("/api/me")
    def me_delete(request: Request, body: DeleteAccount):
        user = accounts.require_user(request)
        if body.confirm != "DELETE":
            raise Invalid('Type DELETE to confirm.')
        accounts.delete_account(user.id)
        response = JSONResponse({"ok": True})
        response.delete_cookie(SESSION_COOKIE, path="/")
        return response

    return router
