"""A project's discussion: only the owner and the people it is shared with can read or post, and research run
in the project sees the recent messages."""
from __future__ import annotations

from test_project_context import capture_pipeline


def shared_project(owner, member) -> str:
    project = owner.post("/api/projects", json={"name": "AR in schools"}).json()["id"]
    assert owner.post(f"/api/projects/{project}/members", json={"orcid": member.me["orcid"]}).status_code == 200
    return project


def test_owner_and_members_share_one_thread(alice, bob):
    project = shared_project(alice, bob)
    first = alice.post(f"/api/projects/{project}/messages", json={"body": "  Can you check the 2023 survey?  "})
    assert first.status_code == 201
    assert first.json()["body"] == "Can you check the 2023 survey?"  # trimmed
    assert bob.post(f"/api/projects/{project}/messages", json={"body": "On it.\nWill post a summary."}).status_code == 201

    for client, mine in ((alice, [True, False]), (bob, [False, True])):
        thread = client.get(f"/api/projects/{project}/messages").json()
        assert [m["body"] for m in thread] == ["Can you check the 2023 survey?", "On it.\nWill post a summary."]
        assert [m["mine"] for m in thread] == mine
        assert thread[0]["author"]["name"] == alice.me["name"]

    since = first.json()["createdAt"]
    newer = alice.get(f"/api/projects/{project}/messages", params={"after": since}).json()
    assert [m["body"] for m in newer] == ["On it.\nWill post a summary."]


def test_outsiders_cannot_read_or_post(alice, bob, carol):
    project = shared_project(alice, bob)
    alice.post(f"/api/projects/{project}/messages", json={"body": "private plan"})
    assert carol.get(f"/api/projects/{project}/messages").status_code == 404
    assert carol.post(f"/api/projects/{project}/messages", json={"body": "hi"}).status_code == 404

    # Removed members lose access too
    alice.delete(f"/api/projects/{project}/members/{bob.me['id']}")
    assert bob.get(f"/api/projects/{project}/messages").status_code == 404


def test_empty_and_overlong_messages_are_refused(alice, bob):
    project = shared_project(alice, bob)
    assert alice.post(f"/api/projects/{project}/messages", json={"body": "   \n "}).status_code == 422
    r = alice.post(f"/api/projects/{project}/messages", json={"body": "x" * 4001})
    assert r.status_code == 422 and "4000" in r.json()["detail"]
    assert alice.get(f"/api/projects/{project}/messages").json() == []


def test_research_sees_the_recent_discussion(alice, bob, monkeypatch):
    project = shared_project(alice, bob)
    bob.post(f"/api/projects/{project}/messages", json={"body": "Focus on secondary schools in India."})
    seen = capture_pipeline(monkeypatch)
    alice.get("/api/research", params={"q": "recent results", "project_id": project})
    assert f"{bob.me['name']}: Focus on secondary schools in India." in seen[-1]["context"]["text"]


def test_deleting_the_project_deletes_its_thread(alice, bob):
    project = shared_project(alice, bob)
    alice.post(f"/api/projects/{project}/messages", json={"body": "temporary"})
    assert alice.delete(f"/api/projects/{project}").status_code == 200
    assert alice.get(f"/api/projects/{project}/messages").status_code == 404
