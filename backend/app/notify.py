"""In-app notifications, plus an optional email copy.

Every notification is stored for the bell in the app. When SMTP is configured (SMTP_HOST, SMTP_FROM and usually
SMTP_USER / SMTP_PASSWORD) and the person added a notification email in their profile, a short email is sent
too. The email never contains the requester's message, so the address cannot be used to relay spam.
"""
from __future__ import annotations

import json
import logging
import os
import smtplib
from email.message import EmailMessage

import sqlalchemy as sa

from .config import settings
from .db import new_id, notifications, now_ms, users

log = logging.getLogger("nemosearch.notify")

SUBJECTS = {
    "request_received": "New request on NemoSearch Network",
    "request_accepted": "Your NemoSearch Network request was accepted",
    "request_declined": "Your NemoSearch Network request was declined",
    "project_shared": "A project was shared with you on NemoSearch",
    "access_granted": "You were given access to a work on NemoSearch Network",
    "work_taken_down": "One of your works on NemoSearch Network was taken down",
}

Email = tuple[str, str, str]  # to, subject, body


def add(conn: sa.Connection, user_id: str, kind: str, data: dict) -> list[Email]:
    """Stores a notification; returns the email to send once the transaction has committed (if any)."""
    conn.execute(notifications.insert().values(
        id=new_id("note"), user_id=user_id, kind=kind, data_json=json.dumps(data), read=False, created_at=now_ms(),
    ))
    if not os.getenv("SMTP_HOST"):
        return []
    to = conn.execute(sa.select(users.c.notify_email).where(users.c.id == user_id)).scalar()
    if not to:
        return []
    subject = SUBJECTS.get(kind, "NemoSearch Network")
    title = data.get("work_title") or data.get("project_name") or ""
    body = f"{subject}{f': {title}' if title else ''}.\n\nOpen NemoSearch to see it: {settings.app_url}/network\n"
    return [(to, subject, body)]


def send(emails: list[Email]) -> None:
    host = os.getenv("SMTP_HOST")
    if not emails or not host:
        return
    try:
        with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "587")), timeout=10) as smtp:
            smtp.starttls()
            if os.getenv("SMTP_USER"):
                smtp.login(os.environ["SMTP_USER"], os.getenv("SMTP_PASSWORD", ""))
            for to, subject, body in emails:
                msg = EmailMessage()
                msg["From"], msg["To"], msg["Subject"] = os.getenv("SMTP_FROM", "no-reply@localhost"), to, subject
                msg.set_content(body)
                smtp.send_message(msg)
    except Exception as e:  # noqa: BLE001 - email is a courtesy copy; the in-app notification already exists
        log.warning("notification email failed: %s", e)
