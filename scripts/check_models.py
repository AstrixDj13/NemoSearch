"""Verify the Nebius key (never printed) and list available NVIDIA/Nemotron models."""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
key = os.getenv("NEBIUS_API_KEY", "").strip()
base = os.getenv("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1/")
print(f"key present: {bool(key)} (length {len(key)})  base_url: {base}")
if not key:
    sys.exit(1)

client = OpenAI(base_url=base, api_key=key)
ids = sorted(m.id for m in client.models.list().data)
print(f"total models: {len(ids)}")
print("NVIDIA / Nemotron models:")
for i in ids:
    if "nvidia" in i.lower() or "nemotron" in i.lower():
        print("  ", i)
print("configured:")
for role in ("NANO", "SUPER", "ULTRA"):
    mid = os.getenv(f"MODEL_{role}", "")
    print(f"   {role:<5} {mid}  ->  {'OK' if mid in ids else 'NOT IN CATALOG'}")
