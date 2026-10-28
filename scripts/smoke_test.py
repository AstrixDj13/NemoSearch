"""Smoke test: stream one research run and print a compact event summary.

Research needs an account, so this signs in with the development login: run the server locally with
AUTH_DEV_LOGIN=1.
"""
import json
import sys

import httpx

sys.stdout.reconfigure(encoding="utf-8")

q = sys.argv[1] if len(sys.argv) > 1 else "How do mixture of experts models work"
depth = sys.argv[2] if len(sys.argv) > 2 else "quick"
counts: dict[str, int] = {}
report = ""
client = httpx.Client(base_url="http://127.0.0.1:8000", timeout=600)
signed_in = client.post("/api/auth/dev-login", json={"name": "Smoke Test"})
if signed_in.status_code != 200:
    sys.exit("Couldn't sign in: start the server with AUTH_DEV_LOGIN=1 (local only).")
with client.stream("GET", "/api/research", params={"q": q, "depth": depth}) as r:
    for line in r.iter_lines():
        if not line.startswith("data: "):
            continue
        ev = json.loads(line[6:])
        t = ev.get("type")
        if not t:
            continue
        counts[t] = counts.get(t, 0) + 1
        if t == "stage":
            print(f"[{ev['agent']:>7}] {ev['status']:<7} {ev['detail']}")
        elif t in ("plan", "critique", "error"):
            print(t.upper(), json.dumps(ev)[:300])
        elif t == "report":
            report += ev["delta"]
        elif t == "done":
            print("DONE", json.dumps(ev))
print("EVENT COUNTS", counts)
print("REPORT PREVIEW:\n", report[:600])
