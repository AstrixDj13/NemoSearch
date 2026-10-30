"""Paper Studio: papers are grounded in the research and project they belong to, shared with the project, and
revised through a chat with the co-author that only one person can drive at a time."""
from __future__ import annotations

import asyncio

import sqlalchemy as sa

from app import main
from app.db import now_ms
from app.latex import cite_library, coauthor_turn
from app.llm import LLM
from test_project_context import collaborate

QUESTION = "What has been published on the topic of this paper since it came out, and what is still open?"
BRIEF = "Since 2021, studies of augmented reality in Indian classrooms report gains in engagement [1]."
SOURCES = [
    {"id": 1, "title": "AR in Indian classrooms", "authors": "Priya Sharma, A. Rao", "url": "https://example.org/ar",
     "quote": "Engagement rose by a third.", "paper": {"authors": ["Priya Sharma", "A. Rao"], "year": 2023, "doi": "10.1/ar"}},
    {"id": 2, "title": "AI tutors after COVID-19", "authors": "example.com", "url": "https://example.com/ai", "quote": "Tutors stayed."},
]


def save_research(client, project=None, question=QUESTION) -> str:
    client.post("/api/reports/import", json=[{"title": question[:60], "question": question, "reportText": BRIEF,
                                              "sourcesData": SOURCES, "sources": len(SOURCES)}])
    rid = client.get("/api/reports?project=unassigned").json()[0]["id"]
    if project:
        client.patch(f"/api/reports/{rid}", json={"projectId": project})
    return rid


def capture_llm(monkeypatch) -> list:
    """Records every prompt sent to the model; the model answers with its mock."""
    seen: list = []
    original = main.llm.chat

    async def chat(role, messages, stats, **kw):  # noqa: ANN001, ANN003
        seen.append({"system": messages[0]["content"], "user": messages[1]["content"]})
        return await original(role, messages, stats, **kw)

    monkeypatch.setattr(main.llm, "chat", chat)
    return seen


def test_draft_is_grounded_in_the_research_and_the_project(alice, bob, monkeypatch):
    work, project = collaborate(alice, bob)
    rid = save_research(bob, project)
    seen = capture_llm(monkeypatch)

    paper = bob.post("/api/papers", json={"reportId": rid}).json()
    drafted = bob.post(f"/api/papers/{paper['id']}/draft", json={}).json()

    prompt = seen[-1]["user"]
    assert QUESTION in prompt and BRIEF in prompt
    assert work["title"] in prompt and "AR and AI adoption in schools" in prompt  # the project's paper and its abstract
    assert "\\cite{sharma2023}" in prompt and "AR in Indian classrooms" in prompt
    assert "Alice" in prompt and "Bob" in prompt  # the project's people are the authors
    assert "routing" not in seen[-1]["system"].lower() and "FLOPs" not in seen[-1]["system"]

    assert "\\begin{document}" in drafted["latex"] and "\\end{document}" in drafted["latex"]
    assert "@article{sharma2023," in drafted["bibtex"] and "doi       = {10.1/ar}" in drafted["bibtex"]
    assert drafted["version"] == 1 and drafted["busy"] is None
    note = drafted["messages"][-1]
    assert note["role"] == "coauthor" and work["title"] in note["body"] and note["body"].startswith(f"{bob.me['name']} asked for a draft")


def test_project_members_share_one_paper_and_others_cannot_see_it(alice, bob, carol):
    _, project = collaborate(alice, bob)
    rid = save_research(bob, project)
    first = bob.post("/api/papers", json={"reportId": rid}).json()
    assert alice.post("/api/papers", json={"reportId": rid}).json()["id"] == first["id"]
    assert [p["id"] for p in alice.get("/api/papers").json()] == [first["id"]]
    assert carol.get(f"/api/papers/{first['id']}").status_code == 404
    assert carol.post("/api/papers", json={"reportId": rid}).status_code == 404
    assert carol.get("/api/papers").json() == []


def test_unassigned_research_gives_a_private_paper(alice, bob):
    rid = save_research(alice)
    paper = alice.post("/api/papers", json={"reportId": rid}).json()
    assert paper["projectId"] is None
    assert bob.get(f"/api/papers/{paper['id']}").status_code == 404


def test_chat_with_the_coauthor_revises_the_paper(alice, bob, monkeypatch):
    _, project = collaborate(alice, bob)
    rid = save_research(alice, project)
    pid = alice.post("/api/papers", json={"reportId": rid}).json()["id"]
    alice.post(f"/api/papers/{pid}/draft", json={})
    seen = capture_llm(monkeypatch)

    after = bob.post(f"/api/papers/{pid}/messages", json={"body": "Add a paragraph on rural schools"}).json()
    assert f"{bob.me['name']}: Add a paragraph on rural schools" in seen[-1]["user"]
    assert "CURRENT PAPER:" in seen[-1]["user"] and QUESTION in seen[-1]["user"]
    assert after["version"] == 2 and "rural schools" in after["latex"]
    author, reply = after["messages"][-2:]
    assert author["author"]["name"].startswith("Bob") and reply["role"] == "coauthor" and reply["version"] == 2

    # A question gets an answer and leaves the paper as it was
    asked = alice.post(f"/api/papers/{pid}/messages", json={"body": "Which section covers engagement?"}).json()
    assert asked["version"] == 2 and asked["messages"][-1]["version"] is None
    # Polling returns only what is new
    assert alice.get(f"/api/papers/{pid}", params={"after": asked["messages"][-1]["createdAt"]}).json()["messages"] == []


def test_one_coauthor_task_at_a_time(alice, bob):
    _, project = collaborate(alice, bob)
    rid = save_research(alice, project)
    paper = alice.post("/api/papers", json={"reportId": rid}).json()
    pid = paper["id"]
    with main.engine.begin() as conn:
        conn.execute(sa.text("update papers set busy_by = :u, busy_since = :t, busy_task = 'writing a new draft' where id = :p"),
                     {"u": alice.me["id"], "t": now_ms(), "p": pid})

    busy = bob.get(f"/api/papers/{pid}").json()["busy"]
    assert busy["by"].startswith("Alice") and busy["task"] == "writing a new draft"
    r = bob.post(f"/api/papers/{pid}/messages", json={"body": "Shorten the abstract"})
    assert r.status_code == 409 and "Alice" in r.json()["detail"]
    assert bob.get(f"/api/papers/{pid}").json()["messages"] == []  # the refused message was not posted
    assert bob.patch(f"/api/papers/{pid}", json={"baseVersion": 0, "latex": "x"}).status_code == 409

    # A task cut off by a restart does not lock the paper forever
    with main.engine.begin() as conn:
        conn.execute(sa.text("update papers set busy_since = :t where id = :p"), {"t": now_ms() - 11 * 60 * 1000, "p": pid})
    assert bob.post(f"/api/papers/{pid}/messages", json={"body": "Shorten the abstract"}).status_code == 200


def test_manual_edits_do_not_overwrite_each_other(alice, bob):
    _, project = collaborate(alice, bob)
    rid = save_research(alice, project)
    pid = alice.post("/api/papers", json={"reportId": rid}).json()["id"]
    v = alice.post(f"/api/papers/{pid}/draft", json={}).json()["version"]

    assert alice.patch(f"/api/papers/{pid}", json={"baseVersion": v, "latex": "alice's text"}).json()["version"] == v + 1
    stale = bob.patch(f"/api/papers/{pid}", json={"baseVersion": v, "latex": "bob's text"})
    assert stale.status_code == 409
    assert bob.get(f"/api/papers/{pid}").json()["latex"] == "alice's text"


def test_citation_keys_are_unique_and_stable():
    library = cite_library(SOURCES + [SOURCES[0]])
    keys = [c["key"] for c in library]
    assert keys == ["sharma2023", "examplecom2", "sharma2023a"]
    assert cite_library(SOURCES)[0]["key"] == keys[0]
    assert "title     = {{AR in Indian classrooms}}" in library[0]["bibtex"]


def test_a_truncated_revision_is_not_applied(monkeypatch):
    llm = LLM()

    async def cut_off(*args, **kw):  # noqa: ANN002, ANN003
        return "<reply>Expanded every section.</reply>\n<latex>\\documentclass{article}\\begin{document}Half a pap"

    monkeypatch.setattr(llm, "chat", cut_off)
    g = {"question": QUESTION, "title": QUESTION, "brief": BRIEF, "sources": SOURCES, "context": "", "authors": []}
    paper = "\\documentclass{article}\\begin{document}Full paper\\end{document}"
    res = asyncio.run(coauthor_turn(g, paper, [{"speaker": "Bob", "text": "expand everything"}], llm))
    assert res["latex"] is None and "cut off" in res["reply"]


def test_talk_before_drafting_steers_the_draft(alice, monkeypatch):
    rid = save_research(alice)
    pid = alice.post("/api/papers", json={"reportId": rid}).json()["id"]
    seen = capture_llm(monkeypatch)

    planned = alice.post(f"/api/papers/{pid}/messages", json={"body": "Focus on teacher training, for policy makers"}).json()
    assert "do not write the paper" in seen[-1]["system"]
    assert planned["hasDraft"] is False and planned["version"] == 0

    alice.post(f"/api/papers/{pid}/draft", json={})
    assert "THE AUTHORS' DIRECTIONS" in seen[-1]["user"] and "Focus on teacher training" in seen[-1]["user"]
