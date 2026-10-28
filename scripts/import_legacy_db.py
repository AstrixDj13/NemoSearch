"""Copy research from the old single-user database (data/nemosearch.db) into one account.

Before accounts existed, everything lived in one SQLite file without owners. This copies its projects, reports,
saved sources, attachments and exports into the account with the given ORCID iD, in whatever database
DATABASE_URL points at (or the local default). The old file is only read, never changed.

    python scripts/import_legacy_db.py 0000-0002-1825-0097
    python scripts/import_legacy_db.py 0000-0002-1825-0097 --legacy path/to/nemosearch.db

The account must exist: sign in once first.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import sqlalchemy as sa  # noqa: E402

from app.blobs import open_blob_store  # noqa: E402
from app.config import settings  # noqa: E402
from app.db import (  # noqa: E402
    attachments, create_db_engine, database_url, exports, init_schema, new_id, projects, reports, saved_sources, users,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("orcid", help="ORCID iD of the account that should own the imported research")
    parser.add_argument("--legacy", default=str(ROOT / "data" / "nemosearch.db"), help="the old database file")
    args = parser.parse_args()

    legacy_path = Path(args.legacy)
    if not legacy_path.exists():
        sys.exit(f"No old database at {legacy_path}.")
    old = sqlite3.connect(f"file:{legacy_path.as_posix()}?mode=ro", uri=True)
    old.row_factory = sqlite3.Row

    engine = create_db_engine(database_url(ROOT))
    init_schema(engine)
    blobs = open_blob_store(ROOT, settings.secret_key)

    with engine.begin() as conn:
        uid = conn.execute(sa.select(users.c.id).where(users.c.orcid == args.orcid.strip())).scalar()
        if uid is None:
            sys.exit(f"No account with ORCID iD {args.orcid}. Sign in once, then run this again.")

        project_ids: dict[str, str] = {}
        for p in old.execute("SELECT * FROM projects"):
            project_ids[p["id"]] = new_id("project")
            conn.execute(projects.insert().values(
                id=project_ids[p["id"]], owner_id=uid, name=p["name"], description=p["description"], notes=p["notes"],
                archived=bool(p["archived"]), created_at=p["created_at"], updated_at=p["updated_at"],
            ))

        report_ids: dict[str, str] = {}
        for seq, r in enumerate(old.execute("SELECT * FROM reports WHERE deleted = 0 ORDER BY rowid")):
            report_ids[r["id"]] = new_id("report")
            keys = r.keys()
            conn.execute(reports.insert().values(
                id=report_ids[r["id"]], owner_id=uid, project_id=project_ids.get(r["project_id"]), title=r["title"],
                question=r["question"], mode=r["mode"], time_label=r["time_label"], sources_count=r["sources_count"],
                report_text=r["report_text"], sources_json=r["sources_json"], reasoning=r["reasoning"],
                models_json=r["models_json"], coverage_json=r["coverage_json"] if "coverage_json" in keys else "{}",
                followups_json=r["followups_json"] if "followups_json" in keys else "[]",
                archived=bool(r["archived"]), deleted=False, created_at=r["created_at"], seq=seq,
            ))

        for s in old.execute("SELECT * FROM saved_sources"):
            conn.execute(saved_sources.insert().values(
                id=new_id("source"), owner_id=uid, project_id=project_ids.get(s["project_id"]),
                report_id=report_ids.get(s["report_id"]), url=s["url"], title=s["title"], source_json=s["source_json"],
                created_at=s["created_at"],
            ))

        files = legacy_path.parent / "attachments"
        for a in old.execute("SELECT * FROM attachments"):
            path = files / a["id"]
            if a["project_id"] not in project_ids or not path.exists():
                continue
            aid = new_id("file")
            blobs.put(f"attachments/{aid}", path.read_bytes(), a["content_type"])
            conn.execute(attachments.insert().values(
                id=aid, owner_id=uid, project_id=project_ids[a["project_id"]], blob_key=f"attachments/{aid}",
                filename=a["filename"], content_type=a["content_type"], size=a["size"], created_at=a["created_at"],
            ))

        for e in old.execute("SELECT * FROM exports"):
            conn.execute(exports.insert().values(
                id=new_id("export"), owner_id=uid, project_id=project_ids.get(e["project_id"]),
                report_id=report_ids.get(e["report_id"]), kind=e["kind"], filename=e["filename"], content=e["content"],
                created_at=e["created_at"],
            ))

    print(f"Imported {len(project_ids)} projects and {len(report_ids)} reports into ORCID {args.orcid}.")


if __name__ == "__main__":
    main()
