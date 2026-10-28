"""Phase 1 and 2: accounts, sign-in, and that nobody can reach another account's private research."""
from __future__ import annotations

import sqlalchemy as sa
from fastapi.testclient import TestClient

from app import main
from app.auth import orcid_valid
from app.config import Settings
from conftest import local_client, login


def make_report(client, title="Solid-state batteries", project=None) -> str:
    r = client.post("/api/reports/import", json=[{"title": title, "question": title, "reportText": f"# {title}\nBody [1]"}])
    assert r.status_code == 200, r.text
    rid = client.get("/api/reports").json()[0]["id"]
    if project:
        assert client.patch(f"/api/reports/{rid}", json={"projectId": project, "moveProject": True}).status_code == 200
    return rid


def test_signed_out_requests_are_refused(anon):
    for path in ("/api/projects", "/api/reports", "/api/sources", "/api/me", "/api/paper/templates",
                 "/api/network/works/mine", "/api/network/requests"):
        assert anon.get(path).status_code == 401, path
    assert anon.get("/api/research", params={"q": "anything at all"}).status_code == 401
    assert anon.post("/api/followup", json={"question": "q", "prior_question": "p", "prior_report": "r"}).status_code == 401
    assert anon.post("/api/projects", json={"name": "x"}).status_code == 401
    assert anon.get("/api/health").status_code == 200


def test_orcid_check_digit():
    assert orcid_valid("0000-0002-1825-0097")
    assert orcid_valid("0000-0001-5109-3700")
    assert orcid_valid("0000-0002-1694-233X")
    assert not orcid_valid("0000-0002-1825-0098")
    assert not orcid_valid("0000-0002-1825-009")


def test_unsafe_configurations_refuse_to_start(monkeypatch):
    monkeypatch.setenv("AUTH_DEV_LOGIN", "1")
    monkeypatch.setenv("APP_URL", "https://nemosearch.example.org")
    assert any("AUTH_DEV_LOGIN" in p for p in Settings().problems())
    monkeypatch.setenv("AUTH_DEV_LOGIN", "0")
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.setenv("DATABASE_URL", "")
    problems = " ".join(Settings().problems())
    assert "SECRET_KEY" in problems and "DATABASE_URL" in problems and "ORCID" in problems and "STORAGE_BACKEND" in problems


def test_logout_ends_the_session(alice):
    assert alice.get("/api/me").status_code == 200
    alice.post("/api/auth/logout")
    alice.cookies.clear()
    assert alice.get("/api/me").status_code == 401


def test_cross_site_writes_are_refused(alice):
    r = alice.post("/api/projects", json={"name": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert alice.post("/api/projects", json={"name": "x"}, headers={"Origin": "http://localhost:8000"}).status_code == 201
    assert alice.post("/api/projects", json={"name": "x"}).status_code == 201  # same-origin requests may omit Origin


def test_private_research_is_invisible_to_others(alice, bob):
    project = alice.post("/api/projects", json={"name": "Thesis"}).json()["id"]
    rid = make_report(alice, project=project)
    source = alice.post("/api/sources", json={"projectId": project, "source": {"url": "https://a.example", "title": "A"}}).json()
    upload = alice.post(f"/api/projects/{project}/attachments", content=b"secret data",
                        headers={"Content-Type": "text/plain", "X-Filename": "notes.txt"})
    assert upload.status_code == 201, upload.text
    attachment = upload.json()["id"]
    export = alice.post("/api/exports", json={"projectId": project, "kind": "md", "filename": "a.md", "content": "x"}).json()["id"]

    assert bob.get("/api/projects").json() == []
    assert bob.get("/api/reports").json() == []
    for path in (f"/api/projects/{project}", f"/api/reports/{rid}", f"/api/attachments/{attachment}",
                 f"/api/exports/{export}/download", f"/api/sources?project={project}"):
        assert bob.get(path).status_code == 404, path
    assert bob.patch(f"/api/reports/{rid}", json={"title": "mine now"}).status_code == 404
    assert bob.delete(f"/api/reports/{rid}").status_code == 404
    assert bob.post(f"/api/reports/{rid}/restore").status_code == 404
    assert bob.post(f"/api/reports/{rid}/duplicate").status_code == 404
    assert bob.delete(f"/api/sources/{source['id']}").status_code == 404
    assert bob.delete(f"/api/attachments/{attachment}").status_code == 404
    assert bob.patch(f"/api/projects/{project}", json={"notes": "hi"}).status_code == 404
    assert bob.delete(f"/api/projects/{project}").status_code == 404
    assert bob.post(f"/api/projects/{project}/attachments", content=b"x", headers={"X-Filename": "x"}).status_code == 404
    # Research saved "into" someone else's project lands in the caller's own Unassigned instead
    bob.post("/api/sources", json={"projectId": project, "source": {"url": "https://b.example"}})
    assert all(s["url"] != "https://b.example" for s in alice.get(f"/api/sources?project={project}").json())

    assert alice.get(f"/api/attachments/{attachment}").content == b"secret data"
    assert alice.get(f"/api/reports/{rid}").json()["title"] == "Solid-state batteries"


def test_follow_ups_check_the_report(alice, bob):
    rid = make_report(alice)
    r = bob.post("/api/followup", json={"question": "q", "prior_question": "p", "prior_report": "r", "report_id": rid})
    assert r.status_code == 404


def test_download_links_are_signed(alice):
    project = alice.post("/api/projects", json={"name": "P"}).json()["id"]
    attachment = alice.post(f"/api/projects/{project}/attachments", content=b"abc", headers={"X-Filename": "a.txt"}).json()["id"]
    r = alice.get(f"/api/attachments/{attachment}", follow_redirects=False)
    assert r.status_code == 303
    link = r.headers["location"]
    assert link.startswith("/api/files/")
    assert alice.get(link).content == b"abc"
    token = link.rsplit("/", 1)[1]
    body, sig = token.rsplit(".", 1)
    assert alice.get(f"/api/files/{body}.{sig[:-2]}xx").status_code == 404
    assert alice.get(f"/api/files/{body[:-3]}abc.{sig}").status_code == 404


def test_imported_ids_never_overwrite_other_reports(alice, bob):
    rid = make_report(alice, title="Original")
    bob.post("/api/reports/import", json=[{"id": rid, "title": "Hijack", "reportText": "x"}])
    assert alice.get(f"/api/reports/{rid}").json()["title"] == "Original"
    assert bob.get(f"/api/reports/{rid}").status_code == 404


def test_project_sharing(alice, bob, carol):
    project = alice.post("/api/projects", json={"name": "Shared"}).json()["id"]
    alice_report = make_report(alice, "Alice's run", project)
    assert alice.post(f"/api/projects/{project}/members", json={"orcid": "0000-0000-0000-0000"}).status_code == 422
    r = alice.post(f"/api/projects/{project}/members", json={"orcid": bob.me["orcid"]})
    assert r.status_code == 200 and r.json()[0]["id"] == bob.me["id"]

    listed = bob.get("/api/projects").json()
    assert [p["id"] for p in listed] == [project] and listed[0]["role"] == "member"
    assert bob.get(f"/api/reports/{alice_report}").status_code == 200
    assert bob.patch(f"/api/projects/{project}", json={"notes": "shared notes"}).status_code == 200
    assert bob.patch(f"/api/projects/{project}", json={"name": "Renamed"}).status_code == 403
    assert bob.delete(f"/api/projects/{project}").status_code == 403
    assert bob.post(f"/api/projects/{project}/members", json={"orcid": carol.me["orcid"]}).status_code == 403
    assert bob.delete(f"/api/reports/{alice_report}").status_code == 404
    bob_report = make_report(bob, "Bob's run", project)
    assert {r["id"] for r in alice.get(f"/api/reports?project={project}").json()} == {alice_report, bob_report}
    # The project owner manages everything in the project
    assert alice.patch(f"/api/reports/{bob_report}", json={"title": "Edited by owner"}).status_code == 200
    assert carol.get(f"/api/reports/{bob_report}").status_code == 404

    assert bob.delete(f"/api/projects/{project}/members/{bob.me['id']}").status_code == 200
    assert bob.get(f"/api/projects/{project}").status_code == 404
    assert bob.get(f"/api/reports/{alice_report}").status_code == 404
    assert bob.get(f"/api/reports/{bob_report}").status_code == 200  # still theirs


def test_paper_templates_are_per_account(alice, bob):
    alice.post("/api/paper/install_template", json={"name": "Lab style", "preamble": "\\usepackage{x}"})
    assert any(t["name"] == "Lab style" for t in alice.get("/api/paper/templates").json()["templates"])
    assert not any(t["name"] == "Lab style" for t in bob.get("/api/paper/templates").json()["templates"])


def test_research_is_rate_limited(alice, monkeypatch):
    monkeypatch.setattr(main.settings, "limit_research_per_day", 0)
    r = alice.get("/api/research", params={"q": "a long enough question"})
    assert r.status_code == 429


def test_account_export_and_deletion(alice, bob):
    project = alice.post("/api/projects", json={"name": "Mine"}).json()["id"]
    alice.post(f"/api/projects/{project}/members", json={"orcid": bob.me["orcid"]})
    bob_report = make_report(bob, "Bob in Alice's project", project)
    exported = alice.get("/api/me/export").json()
    assert exported["projects"][0]["id"] == project

    assert alice.request("DELETE", "/api/me", json={"confirm": "nope"}).status_code == 422
    assert alice.request("DELETE", "/api/me", json={"confirm": "DELETE"}).status_code == 200
    assert alice.get("/api/me").status_code == 401
    # Bob's research survives in his own Unassigned
    report = bob.get(f"/api/reports/{bob_report}").json()
    assert report["projectId"] is None
    with main.engine.connect() as conn:
        assert conn.execute(sa.text("select count(*) from projects where id = :p"), {"p": project}).scalar() == 0


def test_profile_never_exposes_email(alice, bob):
    alice.patch("/api/me", json={"notifyEmail": "alice@example.org", "affiliation": "UCD", "interests": ["batteries"]})
    assert alice.get("/api/me").json()["notifyEmail"] == "alice@example.org"
    public = bob.get(f"/api/network/people/{alice.me['id']}").json()
    assert "alice@example.org" not in str(public)
    assert public["affiliation"] == "UCD"
    assert alice.patch("/api/me", json={"notifyEmail": "not-an-email"}).status_code == 422


def test_sessions_are_hashed_at_rest(alice):
    token = alice.cookies.get("ns_session")
    with main.engine.connect() as conn:
        stored = conn.execute(sa.text("select token_hash from sessions")).scalars().all()
    assert token not in stored


def test_dev_login_is_off_when_disabled(monkeypatch):
    monkeypatch.setattr(main.settings, "dev_login", False)
    client = local_client()
    assert client.post("/api/auth/dev-login", json={"name": "x"}).status_code == 404


def test_dev_login_only_answers_local_requests():
    remote = TestClient(main.app, base_url="http://localhost", client=("203.0.113.9", 50000))
    assert remote.post("/api/auth/dev-login", json={"name": "x"}).status_code == 404
    public_host = TestClient(main.app, base_url="https://nemosearch.example.org", client=("127.0.0.1", 50000))
    assert public_host.post("/api/auth/dev-login", json={"name": "x"}).status_code == 404
