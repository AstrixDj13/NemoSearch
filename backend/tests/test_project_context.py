"""Collaboration projects know their paper, and research run inside a project is given the project's context."""
from __future__ import annotations

import sqlalchemy as sa

from app import main
from app.pipeline import with_context
from test_network import publish


def collaborate(owner, requester, title="Emergence of AR and AI in Educational Institutions") -> tuple[dict, str]:
    work = publish(owner, title, visibility="open", abstract="We study AR and AI adoption in schools during COVID-19.")
    req = requester.post(f"/api/network/works/{work['id']}/requests", json={"kind": "collaborate"}).json()["id"]
    project = owner.post(f"/api/network/requests/{req}/accept", json={}).json()["projectId"]
    return work, project


def capture_pipeline(monkeypatch) -> list:
    seen: list = []

    async def fake_pipeline(question, *args):  # noqa: ANN001, ANN002
        seen.append({"question": question, "context": args[-1]})
        yield {"type": "init", "models": {}, "search_provider": "test"}

    monkeypatch.setattr(main, "run_pipeline", fake_pipeline)
    return seen


def test_collaboration_project_shows_its_paper(alice, bob):
    work, project = collaborate(alice, bob)
    for client in (alice, bob):
        detail = client.get(f"/api/projects/{project}").json()
        assert detail["work"]["id"] == work["id"]
        assert detail["work"]["abstract"].startswith("We study AR and AI")


def test_research_in_a_project_gets_its_context(alice, bob, monkeypatch):
    work, project = collaborate(alice, bob)
    bob.patch(f"/api/projects/{project}", json={"notes": "Focus on secondary schools in India."})
    seen = capture_pipeline(monkeypatch)

    bob.get("/api/research", params={"q": "find recent results on this topic", "project_id": project})
    context = seen[-1]["context"]
    assert context["work"] == work["title"]
    assert work["title"] in context["text"] and "secondary schools in India" in context["text"]
    assert seen[-1]["question"] == "find recent results on this topic"  # the question itself is not rewritten

    bob.get("/api/research", params={"q": "find recent results on this topic", "project_id": project, "use_context": "false"})
    assert seen[-1]["context"] is None
    bob.get("/api/research", params={"q": "a question with no project"})
    assert seen[-1]["context"] is None


def test_no_context_from_projects_you_cannot_see(alice, carol, monkeypatch):
    project = alice.post("/api/projects", json={"name": "Secret", "description": "Confidential plans"}).json()["id"]
    seen = capture_pipeline(monkeypatch)
    carol.get("/api/research", params={"q": "what is in this project", "project_id": project})
    assert seen[-1]["context"] is None


def test_private_paper_is_not_shared_through_a_project(alice, bob, carol):
    work, project = collaborate(alice, bob)
    alice.patch(f"/api/network/works/{work['id']}", json={"visibility": "private"})
    alice.post(f"/api/projects/{project}/members", json={"orcid": carol.me["orcid"]})
    assert carol.get(f"/api/projects/{project}").json()["work"] is None  # carol was never given the paper
    assert bob.get(f"/api/projects/{project}").json()["work"]["id"] == work["id"]  # bob was, when accepted


def test_existing_collaboration_projects_are_linked_on_startup(alice, bob):
    work, project = collaborate(alice, bob)
    with main.engine.begin() as conn:
        conn.execute(sa.text("update projects set work_id = null where id = :p"), {"p": project})
    main.init_schema(main.engine)
    assert alice.get(f"/api/projects/{project}").json()["work"]["id"] == work["id"]


def test_context_is_framed_as_not_evidence():
    framed = with_context("find results on that topic", "Project: X")
    assert framed.startswith("find results on that topic") and "It is not evidence" in framed
    assert with_context("plain", None) == "plain"
