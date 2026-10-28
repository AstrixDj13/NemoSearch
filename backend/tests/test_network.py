"""Phases 3 and 4: publishing, visibility, the ownership log, requests and collaboration."""
from __future__ import annotations

import hashlib

import httpx
import pytest
import sqlalchemy as sa

from app import main
from conftest import PDF


def publish(client, title="Sparse attention for long documents", visibility=None, **extra) -> dict:
    body = {"title": title, "abstract": "We study sparse attention.", "tags": ["Attention", "NLP"], "license": "cc-by", **extra}
    r = client.post("/api/network/works", json=body)
    assert r.status_code == 201, r.text
    work = r.json()
    if visibility:
        upload(client, work["id"])
        r = client.patch(f"/api/network/works/{work['id']}", json={"visibility": visibility, "confirmRights": True})
        assert r.status_code == 200, r.text
        work = r.json()
    return work


def upload(client, work_id, data=PDF, name="paper.pdf"):
    return client.post(f"/api/network/works/{work_id}/versions", content=data,
                       headers={"Content-Type": "application/pdf", "X-Filename": name})


def ids(items) -> set[str]:
    return {w["id"] for w in items}


def test_works_start_private_and_stay_hidden(alice, bob, anon, admin):
    work = publish(alice, "Hidden result")
    assert work["visibility"] == "private"
    upload(alice, work["id"])
    wid = work["id"]
    for client in (bob, anon, admin):
        assert client.get(f"/api/network/works/{wid}").status_code == 404
        assert work["id"] not in ids(client.get("/api/network/works", params={"q": "hidden result"}).json()["items"])
        vid = alice.get(f"/api/network/works/{wid}").json()["versions"][0]["id"]
        assert client.get(f"/api/network/works/{wid}/versions/{vid}/download").status_code == 404
    person = bob.get(f"/api/network/people/{alice.me['id']}").json()
    assert wid not in ids(person["works"])
    assert bob.get("/api/network/related", params={"q": "hidden result"}).json() == []
    assert bob.patch(f"/api/network/works/{wid}", json={"title": "x"}).status_code == 404
    assert bob.delete(f"/api/network/works/{wid}").status_code == 404
    assert upload(bob, wid).status_code == 404
    assert bob.post(f"/api/network/works/{wid}/requests", json={"kind": "access"}).status_code == 404
    assert wid in ids(alice.get("/api/network/works/mine").json())


def test_upload_hash_and_ownership_log(alice):
    work = publish(alice)
    assert upload(alice, work["id"], data=b"not a pdf").status_code == 422
    r = upload(alice, work["id"])
    assert r.status_code == 201, r.text
    detail = r.json()
    version = detail["versions"][0]
    assert version["sha256"] == hashlib.sha256(PDF).hexdigest() and version["version"] == 1
    record = detail["ownership"][0]
    assert record["sha256"] == version["sha256"] and record["orcid"] == alice.me["orcid"] and record["event"] == "upload"
    second = upload(alice, work["id"], data=PDF + b"%v2\n").json()
    assert [v["version"] for v in second["versions"]] == [2, 1]
    assert second["ownership"][1]["prevHash"] == second["ownership"][0]["recordHash"]
    assert alice.get("/api/network/ownership/verify").json()["ok"] is True


def test_ownership_log_is_append_only_and_tamper_evident(alice):
    work = publish(alice)
    upload(alice, work["id"])
    with pytest.raises(sa.exc.DBAPIError):
        with main.engine.begin() as conn:
            conn.execute(sa.text("update ownership_records set sha256 = 'x' where work_id = :w"), {"w": work["id"]})
    with pytest.raises(sa.exc.DBAPIError):
        with main.engine.begin() as conn:
            conn.execute(sa.text("delete from ownership_records where work_id = :w"), {"w": work["id"]})

    # Even someone who bypasses the trigger cannot alter a record without breaking the chain
    drop = ("DROP TRIGGER ownership_records_no_change ON ownership_records" if main.engine.dialect.name == "postgresql"
            else "DROP TRIGGER ownership_records_no_update")
    with main.engine.begin() as conn:
        conn.exec_driver_sql(drop)
        conn.execute(sa.text("update ownership_records set size = size + 1 where work_id = :w"), {"w": work["id"]})
    try:
        assert main.network.verify_chain()["ok"] is False
    finally:
        with main.engine.begin() as conn:
            conn.execute(sa.text("update ownership_records set size = size - 1 where work_id = :w"), {"w": work["id"]})
        main.init_schema(main.engine)
    assert main.network.verify_chain()["ok"] is True


def test_sharing_needs_a_file_and_confirmation(alice, anon):
    work = publish(alice)
    wid = work["id"]
    assert alice.patch(f"/api/network/works/{wid}", json={"visibility": "open", "confirmRights": True}).status_code == 422
    upload(alice, wid)
    assert alice.patch(f"/api/network/works/{wid}", json={"visibility": "open"}).status_code == 422
    assert alice.patch(f"/api/network/works/{wid}", json={"visibility": "sideways", "confirmRights": True}).status_code == 422
    opened = alice.patch(f"/api/network/works/{wid}", json={"visibility": "open", "confirmRights": True}).json()
    assert opened["visibility"] == "open"
    # Changing the license of a shared work needs confirmation again
    assert alice.patch(f"/api/network/works/{wid}", json={"license": "cc0"}).status_code == 422
    assert alice.patch(f"/api/network/works/{wid}", json={"license": "cc0", "confirmRights": True}).status_code == 200
    # Open works are readable without an account
    page = anon.get(f"/api/network/works/{wid}").json()
    assert page["viewer"]["canDownload"] is True
    assert anon.get(f"/api/network/works/{wid}/versions/{page['versions'][0]['id']}/download").content == PDF
    assert wid in ids(anon.get("/api/network/works", params={"q": "sparse attention"}).json()["items"])
    assert wid in ids(anon.get("/api/network/works", params={"tag": "nlp"}).json()["items"])


def test_access_request_flow(alice, bob):
    work = publish(alice, visibility="request")
    wid = work["id"]
    page = bob.get(f"/api/network/works/{wid}").json()
    assert page["viewer"]["access"] == "metadata" and page["viewer"]["canDownload"] is False
    vid = page["versions"][0]["id"]
    assert bob.get(f"/api/network/works/{wid}/versions/{vid}/download").status_code == 403

    assert alice.post(f"/api/network/works/{wid}/requests", json={"kind": "access"}).status_code == 422
    r = bob.post(f"/api/network/works/{wid}/requests", json={"kind": "access", "message": "For my thesis review."})
    assert r.status_code == 201, r.text
    request_id = r.json()["id"]
    assert bob.post(f"/api/network/works/{wid}/requests", json={"kind": "access"}).status_code == 409

    incoming = alice.get("/api/network/requests", params={"box": "incoming"}).json()
    assert incoming[0]["id"] == request_id and incoming[0]["message"] == "For my thesis review."
    assert alice.get("/api/me").json()["pendingRequests"] == 1
    assert alice.get("/api/me").json()["unreadNotifications"] == 1
    assert bob.post(f"/api/network/requests/{request_id}/accept", json={}).status_code == 404

    accepted = alice.post(f"/api/network/requests/{request_id}/accept", json={"response": "Welcome"}).json()
    assert accepted["status"] == "accepted"
    assert bob.get(f"/api/network/works/{wid}/versions/{vid}/download").content == PDF
    assert wid in ids(bob.get("/api/network/works/shared").json())
    assert bob.get("/api/network/notifications").json()[0]["kind"] == "request_accepted"
    assert alice.post(f"/api/network/requests/{request_id}/decline", json={}).status_code == 409


def test_collaboration_opens_a_shared_project(alice, bob):
    work = publish(alice, visibility="open")
    r = bob.post(f"/api/network/works/{work['id']}/requests", json={"kind": "collaborate", "message": "Let's extend this."})
    accepted = alice.post(f"/api/network/requests/{r.json()['id']}/accept", json={}).json()
    project = accepted["projectId"]
    assert project
    shared = bob.get("/api/projects").json()
    assert [p["id"] for p in shared] == [project] and shared[0]["role"] == "member"
    assert alice.get(f"/api/projects/{project}").json()["members"][0]["id"] == bob.me["id"]


def test_collaboration_into_an_existing_project(alice, bob, carol):
    work = publish(alice, visibility="open")
    carol_project = carol.post("/api/projects", json={"name": "Carol's"}).json()["id"]
    req = bob.post(f"/api/network/works/{work['id']}/requests", json={"kind": "collaborate"}).json()["id"]
    assert alice.post(f"/api/network/requests/{req}/accept", json={"projectId": carol_project}).status_code == 422
    own = alice.post("/api/projects", json={"name": "Existing"}).json()["id"]
    assert alice.post(f"/api/network/requests/{req}/accept", json={"projectId": own}).json()["projectId"] == own


def test_withdraw_and_decline(alice, bob):
    work = publish(alice, visibility="request")
    req = bob.post(f"/api/network/works/{work['id']}/requests", json={"kind": "access"}).json()["id"]
    assert alice.post(f"/api/network/requests/{req}/withdraw").status_code == 404
    assert bob.post(f"/api/network/requests/{req}/withdraw").json()["status"] == "withdrawn"
    req = bob.post(f"/api/network/works/{work['id']}/requests", json={"kind": "access"}).json()["id"]
    assert alice.post(f"/api/network/requests/{req}/decline", json={"response": "Not yet"}).json()["status"] == "declined"
    assert bob.get(f"/api/network/works/{work['id']}").json()["viewer"]["canDownload"] is False


def test_blocking_and_request_limits(alice, bob, carol, monkeypatch):
    first = publish(alice, "First", visibility="request")
    assert alice.post(f"/api/network/people/{carol.me['id']}/block").status_code == 200
    assert carol.post(f"/api/network/works/{first['id']}/requests", json={"kind": "access"}).status_code == 403
    assert bob.get(f"/api/network/people/{carol.me['id']}").json()["blockedByYou"] is False

    others = [publish(alice, f"Work {i}", visibility="request") for i in range(3)]
    for w in [first, *others[:2]]:
        assert bob.post(f"/api/network/works/{w['id']}/requests", json={"kind": "access"}).status_code == 201
    assert bob.post(f"/api/network/works/{others[2]['id']}/requests", json={"kind": "access"}).status_code == 409

    monkeypatch.setattr(main.settings, "limit_requests_per_day", 0)
    dave_work = publish(carol, "Carol's", visibility="request")
    assert bob.post(f"/api/network/works/{dave_work['id']}/requests", json={"kind": "access"}).status_code == 429


def test_invitations_to_private_works(alice, bob):
    work = publish(alice, "Invite only")
    upload(alice, work["id"])
    assert alice.post(f"/api/network/works/{work['id']}/access", json={"orcid": "not-an-orcid"}).status_code == 422
    granted = alice.post(f"/api/network/works/{work['id']}/access", json={"orcid": bob.me["orcid"]}).json()
    assert granted["grants"][0]["id"] == bob.me["id"]
    page = bob.get(f"/api/network/works/{work['id']}").json()
    assert page["viewer"]["access"] == "granted" and "grants" not in page
    alice.delete(f"/api/network/works/{work['id']}/access/{bob.me['id']}")
    assert bob.get(f"/api/network/works/{work['id']}").status_code == 404


def test_takedown(alice, bob, admin):
    work = publish(alice, "Disputed", visibility="open")
    assert bob.post("/api/network/abuse", json={"targetKind": "work", "targetId": work["id"], "reason": "copyright",
                                                "details": "This is my paper."}).status_code == 201
    assert bob.get("/api/network/admin/abuse").status_code == 404
    reports = admin.get("/api/network/admin/abuse").json()
    assert any(r["targetId"] == work["id"] for r in reports)

    admin.post(f"/api/network/admin/works/{work['id']}/takedown", json={"reason": "Copyright notice received"})
    assert bob.get(f"/api/network/works/{work['id']}").status_code == 404
    assert work["id"] not in ids(bob.get("/api/network/works").json()["items"])
    page = alice.get(f"/api/network/works/{work['id']}").json()
    assert page["takenDown"] is True and page["takedownReason"] == "Copyright notice received"
    assert alice.patch(f"/api/network/works/{work['id']}", json={"visibility": "request", "confirmRights": True}).status_code == 422
    admin.post(f"/api/network/admin/works/{work['id']}/takedown", json={"down": False})
    assert bob.get(f"/api/network/works/{work['id']}").status_code == 200


def test_deleting_a_work_keeps_its_ownership_record(alice):
    work = publish(alice, visibility="open")
    alice.delete(f"/api/network/works/{work['id']}")
    assert alice.get(f"/api/network/works/{work['id']}").status_code == 404
    with main.engine.connect() as conn:
        kept = conn.execute(sa.text("select count(*) from ownership_records where work_id = :w"), {"w": work["id"]}).scalar()
    assert kept == 1
    assert main.network.verify_chain()["ok"] is True


def test_publish_a_report(alice, bob):
    alice.post("/api/reports/import", json=[{"title": "MoE inference", "reportText": "# MoE inference\nFindings [1]"}])
    rid = alice.get("/api/reports").json()[0]["id"]
    stolen = bob.post("/api/network/works", json={"title": "Stolen", "license": "cc-by", "reportId": rid})
    assert stolen.status_code == 422
    work = publish(alice, "MoE inference", reportId=rid)
    assert work["versions"][0]["filename"] == "moe-inference.md"
    assert work["versions"][0]["sha256"] == hashlib.sha256(b"# MoE inference\nFindings [1]").hexdigest()


def test_publishing_requires_a_license(alice):
    assert alice.post("/api/network/works", json={"title": "No license"}).status_code == 422
    assert alice.post("/api/network/works", json={"title": "Bad license", "license": "wtfpl"}).status_code == 422


def test_organizations(alice, bob, admin):
    assert alice.post("/api/network/orgs", json={"name": "Lab", "rorId": "not-ror"}).status_code == 422
    org = alice.post("/api/network/orgs", json={"name": "Battery Lab", "rorId": "https://ror.org/05m7pjf47"}).json()
    assert org["rorId"] == "05m7pjf47" and org["verified"] is False and org["yourRole"] == "admin"
    assert bob.post("/api/network/orgs", json={"name": "Copy", "rorId": "05m7pjf47"}).status_code == 409
    assert bob.post("/api/network/works", json={"title": "x", "license": "cc-by", "orgId": org["id"]}).status_code == 422
    assert bob.patch(f"/api/network/orgs/{org['id']}", json={"name": "Mine"}).status_code == 403

    alice.post(f"/api/network/orgs/{org['id']}/members", json={"orcid": bob.me["orcid"]})
    work = publish(bob, "Lab result", visibility="open", orgId=org["id"])
    assert work["org"]["id"] == org["id"]
    assert work["id"] in ids(bob.get(f"/api/network/orgs/{org['id']}").json()["works"])

    assert bob.post(f"/api/network/admin/orgs/{org['id']}/verify", json={}).status_code == 404
    assert admin.post(f"/api/network/admin/orgs/{org['id']}/verify", json={}).json()["verified"] is True
    # Renaming drops the badge until an admin checks again
    assert alice.patch(f"/api/network/orgs/{org['id']}", json={"name": "Battery Lab II"}).json()["verified"] is False
    assert alice.delete(f"/api/network/orgs/{org['id']}/members/{alice.me['id']}").status_code == 422


def _sources(openalex_orcid: str | None, orcid_records: dict[str, list[str]] | None = None):
    """Fake OpenAlex (authorship carries openalex_orcid, or no iD) and ORCID (orcid -> DOIs on that record)."""
    orcid_records = orcid_records or {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.openalex.org":
            assert request.url.path == "/works/doi:10.1234/example.5678"
            return httpx.Response(200, json={
                "id": "https://openalex.org/W1", "display_name": "A claimed paper",
                "abstract_inverted_index": {"We": [0], "claim": [1]},
                "authorships": [{"author": {"display_name": "Someone",
                                            "orcid": f"https://orcid.org/{openalex_orcid}" if openalex_orcid else None}}],
                "primary_location": {"landing_page_url": "https://journal.example/paper"},
                "primary_topic": {"display_name": "Energy Storage"},
            })
        assert request.url.host == "pub.orcid.org"
        orcid = request.url.path.split("/")[2]
        groups = [{"work-summary": [{
            "title": {"title": {"value": "A claimed paper"}},
            "external-ids": {"external-id": [{"external-id-type": "doi", "external-id-value": d.upper(),
                                              "external-id-relationship": "self"}]},
            "source": {"source-name": {"value": "Crossref Metadata Search"},
                       "source-client-id": {"path": "0000-0002-3054-1567"},
                       "assertion-origin-orcid": {"path": orcid}},
        }]} for d in orcid_records.get(orcid, [])]
        return httpx.Response(200, json={"group": groups})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_claims_need_the_claimants_orcid(alice, bob, monkeypatch):
    monkeypatch.setattr(main.network, "http", _sources(alice.me["orcid"]))
    assert bob.post("/api/network/claims", json={"doi": "https://doi.org/10.1234/example.5678"}).status_code == 422
    r = alice.post("/api/network/claims", json={"doi": "https://doi.org/10.1234/example.5678"})
    assert r.status_code == 201, r.text
    work = r.json()
    assert work["claimed"] and work["visibility"] == "open" and work["externalUrl"] == "https://journal.example/paper"
    assert work["abstract"] == "We claim" and work["ownership"][0]["event"] == "claim"
    assert work["claimEvidence"].startswith("OpenAlex lists")
    assert alice.post("/api/network/claims", json={"doi": "10.1234/example.5678"}).status_code == 409
    assert upload(alice, work["id"]).status_code == 422


def test_claims_fall_back_to_the_claimants_orcid_record(alice, bob, monkeypatch):
    # OpenAlex names the author but has not linked an ORCID iD; the paper is on Alice's ORCID record
    monkeypatch.setattr(main.network, "http", _sources(None, {alice.me["orcid"]: ["10.1234/example.5678"]}))
    assert bob.post("/api/network/claims", json={"doi": "10.1234/example.5678"}).status_code == 422
    r = alice.post("/api/network/claims", json={"doi": "10.1234/EXAMPLE.5678"})
    assert r.status_code == 201, r.text
    assert r.json()["claimEvidence"] == (
        "Listed on the claimant's ORCID record (added by the researcher using Crossref Metadata Search).")


def test_people_search(alice, bob):
    alice.patch("/api/me", json={"affiliation": "Quantum Materials Group", "interests": ["superconductors"]})
    found = bob.get("/api/network/people", params={"q": "superconductors"}).json()
    assert alice.me["id"] in {p["id"] for p in found}


def test_concurrent_uploads_keep_one_chain(alice, bob):
    from concurrent.futures import ThreadPoolExecutor

    works = [publish(c, f"Parallel {i}") for i, c in enumerate([alice, bob] * 4)]
    owners = [alice, bob] * 4
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda pair: upload(pair[0], pair[1]["id"], data=PDF + pair[1]["id"].encode()), zip(owners, works)))
    assert all(r.status_code == 201 for r in results), [r.text for r in results if r.status_code != 201]
    assert main.network.verify_chain()["ok"] is True
