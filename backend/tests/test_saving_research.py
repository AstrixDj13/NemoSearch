"""Research outside a project is kept in Recent research until the user saves it to their Library; research in a
project is part of the project and always saved."""
from __future__ import annotations

import sqlalchemy as sa

from app import main


def finished_run(monkeypatch) -> None:
    async def fake_pipeline(question, *args):  # noqa: ANN001, ANN002
        yield {"type": "init", "models": {}, "search_provider": "test"}
        yield {"type": "report", "delta": "A short answer."}
        yield {"type": "done", "n_sources": 0, "sources": {}}

    monkeypatch.setattr(main, "run_pipeline", fake_pipeline)


def run(client, q: str, project: str | None = None) -> dict:
    client.get("/api/research", params={"q": q, **({"project_id": project} if project else {})})
    return next(r for r in client.get("/api/reports").json() if r["question"] == q)


def test_unassigned_research_starts_unsaved_and_can_be_saved(alice, monkeypatch):
    finished_run(monkeypatch)
    report = run(alice, "ram price hike")
    assert report["saved"] is False and report["projectId"] is None

    saved = alice.patch(f"/api/reports/{report['id']}", json={"saved": True}).json()
    assert saved["saved"] is True
    assert alice.patch(f"/api/reports/{report['id']}", json={"saved": False}).json()["saved"] is False


def test_research_in_a_project_is_saved(alice, monkeypatch):
    finished_run(monkeypatch)
    project = alice.post("/api/projects", json={"name": "Thesis"}).json()["id"]
    assert run(alice, "a project question", project)["saved"] is True

    loose = run(alice, "a loose question")
    moved = alice.patch(f"/api/reports/{loose['id']}", json={"projectId": project, "moveProject": True}).json()
    assert moved["saved"] is True  # moving research into a project saves it


def test_only_the_owner_can_save(alice, bob, monkeypatch):
    finished_run(monkeypatch)
    report = run(alice, "alice's own question")
    assert bob.patch(f"/api/reports/{report['id']}", json={"saved": True}).status_code == 404


def test_reports_from_before_saving_existed_count_as_saved(alice):
    alice.post("/api/reports/import", json=[{"title": "Old run", "question": "Old run", "mode": "All web", "time": "", "sources": 0}])
    old = next(r for r in alice.get("/api/reports").json() if r["title"] == "Old run")
    assert old["saved"] is True
    with main.engine.connect() as conn:  # the column's default is what existing rows get when it is added
        default = next(c for c in sa.inspect(conn).get_columns("reports") if c["name"] == "saved")["default"]
    assert default is not None and default.strip("'()").lower() in ("1", "true")
