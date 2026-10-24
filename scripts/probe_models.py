"""Probe each configured Nemotron model: latency, reasoning format, JSON compliance."""
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
client = OpenAI(base_url=os.getenv("NEBIUS_BASE_URL"), api_key=os.getenv("NEBIUS_API_KEY"))

PROMPT = 'Return ONLY JSON: {"answer": <integer>} for: what is 17*23?'
VARIANTS = {
    "plain": dict(messages=[{"role": "user", "content": PROMPT}]),
    "no_think_sys": dict(messages=[{"role": "system", "content": "/no_think"}, {"role": "user", "content": PROMPT}]),
    "enable_thinking_false": dict(messages=[{"role": "user", "content": PROMPT}],
                                  extra_body={"chat_template_kwargs": {"enable_thinking": False}}),
}

for role in ("NANO", "SUPER", "ULTRA"):
    model = os.getenv(f"MODEL_{role}")
    print(f"\n=== {role}: {model}")
    for name, kw in VARIANTS.items():
        t0 = time.perf_counter()
        try:
            r = client.chat.completions.create(model=model, max_tokens=1500, temperature=0.2, **kw)
            m = r.choices[0].message
            rc = getattr(m, "reasoning_content", None) or (m.model_extra or {}).get("reasoning_content") \
                or (m.model_extra or {}).get("reasoning")
            content = m.content or ""
            print(f"  [{name:<22}] {time.perf_counter()-t0:5.1f}s  tokens={r.usage.completion_tokens if r.usage else '?'}"
                  f"  reasoning_field={len(rc) if rc else 0}ch  think_tag={'<think>' in content or '</think>' in content}")
            print(f"     content: {content[-160:]!r}")
        except Exception as e:  # noqa: BLE001
            print(f"  [{name:<22}] ERROR {str(e)[:200]}")
