"""Thin wrapper around Nebius Token Factory (OpenAI-compatible) for NVIDIA Nemotron models.

Implements "right model for the right task" routing:
  - nano  -> fast, cheap structured calls (planning, critique)
  - super -> mid-size, parallel reading / extraction
  - ultra -> deep reasoning + final synthesis

If no NEBIUS_API_KEY is set, runs in MOCK mode so the UI can be demoed offline.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable, Optional

log = logging.getLogger("nemosearch.llm")

DEFAULT_MODELS = {
    "nano": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    "super": "nvidia/nemotron-3-super-120b-a12b",
    "ultra": "nvidia/Nemotron-3-Ultra-550b-a55b",
}
ROLE_KEYWORDS = {"nano": ["nano"], "super": ["super"], "ultra": ["ultra"]}
# Pipeline step -> model tier used when the user keeps the recommended routing
STEP_ROLES = {"planner": "nano", "reader": "super", "critic": "nano", "writer": "ultra"}


def thinking_kwargs(on: bool) -> dict:
    """Nemotron 3 toggles reasoning through the chat template (reasoning arrives in `reasoning_content`)."""
    return {"extra_body": {"chat_template_kwargs": {"enable_thinking": on}}}


def _reasoning_of(obj) -> Optional[str]:
    extra = getattr(obj, "model_extra", None) or {}
    return getattr(obj, "reasoning_content", None) or extra.get("reasoning_content") or extra.get("reasoning")


def strip_think(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    if "</think>" in text:  # model emitted reasoning without an opening tag
        text = text.split("</think>", 1)[1]
    return text.strip()


def extract_json(text: str) -> Optional[dict]:
    text = strip_think(text)
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.S)
    candidates = [fence.group(1)] if fence else []
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            continue
    return None


class ThinkSplitter:
    """Incrementally separates <think>...</think> reasoning from answer text in a stream."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.buf = ""
        self.in_think = False

    def feed(self, s: str) -> list[tuple[str, str]]:
        self.buf += s
        out: list[tuple[str, str]] = []
        while True:
            tag = self.CLOSE if self.in_think else self.OPEN
            kind = "think" if self.in_think else "text"
            i = self.buf.find(tag)
            if i == -1:
                safe = len(self.buf) - len(tag)
                if safe > 0:
                    out.append((kind, self.buf[:safe]))
                    self.buf = self.buf[safe:]
                break
            if i > 0:
                out.append((kind, self.buf[:i]))
            self.buf = self.buf[i + len(tag) :]
            self.in_think = not self.in_think
        return [(k, v) for k, v in out if v]

    def flush(self) -> list[tuple[str, str]]:
        rest, self.buf = self.buf, ""
        return [("think" if self.in_think else "text", rest)] if rest else []


@dataclass
class RoleStats:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency: float = 0.0

    def to_dict(self) -> dict:
        return {
            "calls": self.calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "latency": round(self.latency, 2),
        }


@dataclass
class RunStats:
    roles: dict[str, RoleStats] = field(
        default_factory=lambda: {r: RoleStats() for r in DEFAULT_MODELS}
    )

    def add(self, role: str, latency: float, usage: Optional[dict]) -> None:
        s = self.roles[role]
        s.calls += 1
        s.latency += latency
        if usage:
            s.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            s.completion_tokens += int(usage.get("completion_tokens") or 0)

    def to_dict(self) -> dict:
        return {r: s.to_dict() for r, s in self.roles.items()}


def _approx_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class LLM:
    def __init__(self) -> None:
        self.api_key = os.getenv("NEBIUS_API_KEY", "").strip()
        self.base_url = os.getenv("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1/")
        self.mock = (not self.api_key) or os.getenv("MOCK_MODE", "0") == "1"
        self.models = {r: os.getenv(f"MODEL_{r.upper()}", d).strip() for r, d in DEFAULT_MODELS.items()}
        self.available: list[str] = []
        self.client = None
        if not self.mock:
            from openai import AsyncOpenAI

            self.client = AsyncOpenAI(base_url=self.base_url, api_key=self.api_key, timeout=240)

    # ------------------------------------------------------------------ setup
    async def resolve_models(self) -> None:
        """Verify configured model IDs exist; auto-pick a matching Nemotron model if not."""
        if self.mock:
            return
        try:
            res = await self.client.models.list()
            self.available = [m.id for m in res.data]
        except Exception as e:  # noqa: BLE001
            log.warning("Could not list models (%s); using configured IDs as-is", e)
            return
        for role, mid in self.models.items():
            if mid in self.available:
                continue
            cands = sorted(
                (i for i in self.available
                 if "nemotron" in i.lower() and any(k in i.lower() for k in ROLE_KEYWORDS[role])),
                key=lambda i: ("vl" in i.lower(), i),  # prefer text-only models
            )
            if cands:
                log.warning("Model %s not found for role %s; using %s", mid, role, cands[0])
                self.models[role] = cands[0]
            else:
                log.warning("No Nemotron '%s' model found in catalog; keeping %s", role, mid)

    def chat_models(self) -> list[str]:
        """Models a user may pick for a pipeline step: the catalog minus embedding models, Nemotron first."""
        catalog = self.available or list(dict.fromkeys(self.models.values()))
        chat = [m for m in catalog if "embedding" not in m.lower()]
        return sorted(chat, key=lambda m: ("nemotron" not in m.lower(), m.lower()))

    def step_models(self, overrides: Optional[dict] = None) -> dict[str, str]:
        """Resolves the model for each pipeline step, ignoring overrides that are not in the catalog."""
        allowed = set(self.chat_models())
        out = {}
        for step, role in STEP_ROLES.items():
            pick = str((overrides or {}).get(step) or "").strip()
            out[step] = pick if pick and (pick in allowed or not self.available) else self.models[role]
        return out

    def info(self) -> dict:
        return {"mock": self.mock, "base_url": self.base_url, "models": self.models}

    # ------------------------------------------------------------------ calls
    async def chat(
        self,
        role: str,
        messages: list[dict],
        stats: RunStats,
        *,
        max_tokens: int = 1024,
        temperature: float = 0.3,
        thinking: bool = False,
        mock: Optional[Callable[[], str]] = None,
        model: Optional[str] = None,
    ) -> str:
        t0 = time.perf_counter()
        if self.mock:
            await asyncio.sleep({"nano": 0.4, "super": 0.9, "ultra": 1.5}[role])
            text = mock() if mock else "{}"
            stats.add(role, time.perf_counter() - t0, {
                "prompt_tokens": sum(_approx_tokens(m["content"]) for m in messages),
                "completion_tokens": _approx_tokens(text),
            })
            return text

        last_err: Exception | None = None
        for attempt in range(3):
            try:
                resp = await self.client.chat.completions.create(
                    model=model or self.models[role],
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    **thinking_kwargs(thinking),
                )
                text = resp.choices[0].message.content or ""
                usage = resp.usage.model_dump() if resp.usage else None
                stats.add(role, time.perf_counter() - t0, usage)
                return strip_think(text)
            except Exception as e:  # noqa: BLE001
                last_err = e
                log.warning("chat(%s) attempt %d failed: %s", role, attempt + 1, e)
                await asyncio.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"{role} model call failed: {last_err}")

    async def stream(
        self,
        role: str,
        messages: list[dict],
        stats: RunStats,
        *,
        max_tokens: int = 8192,
        temperature: float = 0.6,
        thinking: bool = True,
        mock: Optional[Callable[[], tuple[str, str]]] = None,
        model: Optional[str] = None,
    ) -> AsyncIterator[tuple[str, str]]:
        """Yields ("think" | "text", delta)."""
        t0 = time.perf_counter()
        if self.mock:
            think, text = mock() if mock else ("", "")
            for kind, body, delay in (("think", think, 0.012), ("text", text, 0.018)):
                for chunk in re.findall(r"\S+\s*|\s+", body):
                    yield kind, chunk
                    await asyncio.sleep(delay)
            stats.add(role, time.perf_counter() - t0, {
                "prompt_tokens": sum(_approx_tokens(m["content"]) for m in messages),
                "completion_tokens": _approx_tokens(think + text),
            })
            return

        kwargs = dict(
            model=model or self.models[role], messages=messages, max_tokens=max_tokens,
            temperature=temperature, stream=True, **thinking_kwargs(thinking),
        )
        try:
            resp = await self.client.chat.completions.create(
                **kwargs, stream_options={"include_usage": True}
            )
        except Exception:  # noqa: BLE001 - provider may not support stream_options
            resp = await self.client.chat.completions.create(**kwargs)

        splitter = ThinkSplitter()
        usage = None
        produced = ""
        async for chunk in resp:
            if getattr(chunk, "usage", None):
                usage = chunk.usage.model_dump()
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            reasoning = _reasoning_of(delta)
            if reasoning:
                produced += reasoning
                yield "think", reasoning
            if delta.content:
                produced += delta.content
                for kind, piece in splitter.feed(delta.content):
                    yield kind, piece
        for kind, piece in splitter.flush():
            yield kind, piece
        if usage is None:
            usage = {
                "prompt_tokens": sum(_approx_tokens(m["content"]) for m in messages),
                "completion_tokens": _approx_tokens(produced),
            }
        stats.add(role, time.perf_counter() - t0, usage)
