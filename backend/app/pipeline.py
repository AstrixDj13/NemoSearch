"""NemoSearch multi-agent pipeline with Perplexity-grade capabilities:
- Focus modes (web, academic, finance, news)
- Verbatim quote extraction for hover verification
- Multi-turn Follow-up Q&A stream (Nemotron reasoning over prior report + evidence)
- Slide Outline & Executive Brief synthesizers
"""
from __future__ import annotations

import asyncio
import random
import re
import time
from typing import AsyncIterator

from .llm import LLM, RunStats, extract_json
from .scholar import generate_bibtex, sanitize_bib_key, search_academic_multi
from .search import Search


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if len(s.strip()) > 30]


# ---------------------------------------------------------------- agents
async def plan(llm: LLM, stats: RunStats, question: str, n: int, provider: str = "tavily", focus: str = "web",
               model: str | None = None) -> dict:
    focus_guide = {
        "academic": "Focus queries on scholarly, peer-reviewed papers, arXiv preprints, technical benchmarks, and methodology.",
        "finance": "Focus queries on SEC filings, market valuations, earnings, fiscal guidance, revenue metrics, and investor forecasts.",
        "news": "Focus queries on recent breaking developments, press announcements, executive statements, and recent policy changes (2025-2026).",
        "web": "Ensure comprehensive coverage across technical, industrial, and practical perspectives."
    }.get(focus, "")

    style = (
        "Each query must be a SHORT encyclopedia-style topic of 2-5 words (e.g. 'Solid-state battery roadmap'), "
        "because the search engine is Wikipedia keyword search."
        if provider == "wikipedia" else
        "Each query should be a precise search query of 4-10 words."
    )
    sys = (
        "You are the Planner agent of an elite research team. Decompose the user's research question "
        f"into exactly {n} diverse, high-signal search queries that together cover: background, "
        f"latest developments, quantitative statistics, competing viewpoints and limitations.\n"
        f"{focus_guide}\n{style}\n"
        'Respond with ONLY JSON: {"angle": "<one-sentence research strategy>", "sub_queries": ["...", "..."]}'
    )

    def mock() -> str:
        import json
        q = question.rstrip("?")
        qs = [q, f"{q} recent developments", f"{q} evidence and statistics",
              f"{q} criticism and limitations", f"{q} future outlook"][:n]
        return json.dumps({"angle": "Survey background, then weigh recent evidence against known limitations.", "sub_queries": qs})

    raw = await llm.chat("nano", [{"role": "system", "content": sys}, {"role": "user", "content": question}],
                         stats, max_tokens=600, temperature=0.4, mock=mock, model=model)
    data = extract_json(raw) or {}
    queries = [q for q in data.get("sub_queries", []) if isinstance(q, str) and q.strip()][:n]
    if not queries:
        queries = [question]
    return {"angle": data.get("angle", ""), "sub_queries": queries}


async def read(llm: LLM, stats: RunStats, question: str, src: dict, model: str | None = None) -> dict:
    sys = (
        "You are a Precision Reader agent. Given a research question and one source document, extract only "
        "concrete evidence that helps answer the question. Prefer exact numbers, percentages, dates, and named entities.\n"
        "Crucially: extract at least one VERBATIM quote (15-40 words) directly from the text to allow instant source verification.\n"
        'Respond with ONLY JSON:\n'
        '{\n'
        '  "relevance": <0-10 integer>,\n'
        '  "summary": "<one crisp sentence>",\n'
        '  "quote": "<exact verbatim quote from text for verification>",\n'
        '  "facts": ["<fact 1>", "<fact 2>"]\n'
        '}'
    )
    user = f"QUESTION: {question}\n\nSOURCE TITLE: {src['title']}\nURL: {src['url']}\n\nDOCUMENT:\n{src['content'][:5500]}"

    def mock() -> str:
        import json
        sents = _sentences(src["content"]) or [src["title"]]
        quote = sents[0] if len(sents) > 0 else src["title"]
        return json.dumps({
            "relevance": random.randint(5, 9),
            "summary": sents[0][:220],
            "quote": quote[:180],
            "facts": [s[:240] for s in sents[1:4]]
        })

    raw = await llm.chat("super", [{"role": "system", "content": sys}, {"role": "user", "content": user}],
                         stats, max_tokens=800, temperature=0.2, mock=mock, model=model)
    data = extract_json(raw) or {}
    try:
        rel = max(0, min(10, int(data.get("relevance", 0))))
    except (TypeError, ValueError):
        rel = 0
    facts = [f for f in data.get("facts", []) if isinstance(f, str)][:5]
    quote = str(data.get("quote", "")).strip()
    if not quote and src.get("content"):
        sents = _sentences(src["content"])
        quote = sents[0][:200] if sents else src["title"]
    return {
        "id": src["id"],
        "relevance": rel,
        "summary": data.get("summary", ""),
        "quote": quote,
        "facts": facts,
    }


async def critique(llm: LLM, stats: RunStats, question: str, notes: list[dict], model: str | None = None) -> dict:
    digest = "\n".join(f"[{n['id']}] (rel {n['relevance']}) {n['summary']}" for n in notes)
    sys = (
        "You are the Critic agent. Judge whether the collected evidence is sufficient to answer the "
        "question rigorously. Identify missing angles and propose at most 2 follow-up search queries.\n"
        'Respond with ONLY JSON: {"coverage": <0-10>, "gaps": ["..."], "follow_up_queries": ["..."]}'
    )

    def mock() -> str:
        import json
        return json.dumps({"coverage": 7, "gaps": ["Few quantitative benchmarks", "Limited non-Western perspectives"],
                           "follow_up_queries": [f"{question.rstrip('?')} statistics 2026"]})

    raw = await llm.chat("nano", [{"role": "system", "content": sys},
                                  {"role": "user", "content": f"QUESTION: {question}\n\nEVIDENCE:\n{digest}"}],
                         stats, max_tokens=500, mock=mock, model=model)
    data = extract_json(raw) or {}
    return {
        "coverage": data.get("coverage", 0),
        "gaps": [g for g in data.get("gaps", []) if isinstance(g, str)][:4],
        "follow_up_queries": [q for q in data.get("follow_up_queries", []) if isinstance(q, str)][:2],
    }


def _evidence_block(sources: dict[int, dict], notes: list[dict]) -> str:
    parts = []
    for n in notes:
        s = sources[n["id"]]
        facts = "\n".join(f"  - {f}" for f in n["facts"])
        quote_line = f"  Verified quote: \"{n['quote']}\"" if n.get("quote") else ""
        parts.append(f"[{n['id']}] {s['title']} ({s['domain']})\n  Summary: {n['summary']}\n{quote_line}\n{facts}")
    return "\n\n".join(parts)


def _mock_report(question: str, sources: dict[int, dict], notes: list[dict], gaps: list[str]) -> tuple[str, str]:
    think = (
        f"The user asks: \"{question}\". I have {len(notes)} relevant sources. "
        "Grouping into core themes, extracting quantitative statistics, and ensuring each paragraph "
        "contains precise bracketed citations matching the sources.\n"
    )
    top = notes[:6]
    findings = "\n".join(
        f"- **{sources[n['id']]['title']}** — {n['summary']} [{n['id']}]" for n in top
    )
    analysis = " ".join(f"{(n['facts'] or [n['summary']])[0]} [{n['id']}]." for n in top[:4])
    lim = "\n".join(f"- {g}" for g in gaps) or "- Evidence base is limited to retrieved sources."
    text = (
        f"# {question.rstrip('?')}: Research Brief\n\n"
        "> ⚠️ *Demo mode: generated without a Nebius API key. Add `NEBIUS_API_KEY` to `.env` for real Nemotron output.*\n\n"
        "**TL;DR**\n"
        + "\n".join(f"- {n['summary']} [{n['id']}]" for n in top[:3])
        + f"\n\n## Key Findings\n{findings}\n\n## Analysis\n{analysis}\n\n"
        f"## Limitations & Open Questions\n{lim}\n\n"
        "## Bottom Line\nThe retrieved evidence gives a consistent picture, but conclusions should be "
        f"weighed against the gaps above [{top[0]['id'] if top else 1}].\n"
    )
    return think, text


# ---------------------------------------------------------------- orchestrator
async def run_pipeline(question: str, depth: str, focus: str, llm: LLM, search: Search,
                       models: dict | None = None, provider: str | None = None) -> AsyncIterator[dict]:
    t_start = time.perf_counter()
    stats = RunStats()
    deep = depth == "deep"
    n_queries = 5 if deep else 3
    sources: dict[int, dict] = {}
    seen_urls: set[str] = set()
    notes: list[dict] = []
    step_models = llm.step_models(models)
    provider = search.resolve_provider(provider)

    def stage(agent: str, status: str, detail: str = "", step: str | None = None) -> dict:
        ev = {"type": "stage", "agent": agent, "status": status, "detail": detail}
        if step:
            ev["model"] = step_models[step] if not llm.mock else f"{step_models[step]} (mock)"
        return ev

    yield {
        "type": "init", "question": question, "depth": depth, "focus": focus,
        "mock": llm.mock, "models": step_models, "search_provider": provider
    }

    # 1. PLAN -----------------------------------------------------------
    yield stage("planner", "running", f"Decomposing question for {focus.upper()} focus", "planner")
    p = await plan(llm, stats, question, n_queries, provider, focus, model=step_models["planner"])
    yield {"type": "plan", **p}
    yield stage("planner", "done", f"{len(p['sub_queries'])} sub-queries", "planner")

    async def scout_and_read(queries: list[str], round_no: int):
        # 2. SCOUT ------------------------------------------------------
        yield stage("scout", "running", f"Round {round_no}: searching {len(queries)} queries via {provider} [{focus}]")
        search_futs = [search.search(q, 4 if deep else 3, focus, provider) for q in queries]
        if focus == "academic" and round_no == 1:
            search_futs.append(search_academic_multi(question, limit=8))
        results = await asyncio.gather(*search_futs)
        new: list[dict] = []
        for batch in results:
            for r in batch:
                if not r["url"] or r["url"] in seen_urls:
                    continue
                seen_urls.add(r["url"])
                r["id"] = len(sources) + 1
                if "bib_key" not in r:
                    author_val = r.get("authors") or r.get("domain") or "ref"
                    r["bib_key"] = sanitize_bib_key(author_val, 2024, r["title"])
                if "bibtex" not in r:
                    r["bibtex"] = generate_bibtex(
                        r["bib_key"], r["title"], r.get("authors") or r.get("domain", "Web"),
                        2024, r.get("venue", r.get("domain", "")), r.get("doi", ""), r["url"]
                    )
                sources[r["id"]] = r
                new.append(r)
                yield {
                    "type": "source",
                    "source": {k: v for k, v in r.items() if k != "content"} | {"snippet": r["content"][:280]}
                }
        yield stage("scout", "done", f"{len(sources)} unique sources")

        # 3. READ (parallel) ---------------------------------------------
        if not new:
            return
        yield stage("reader", "running", f"Reading {len(new)} sources in parallel", "reader")
        sem = asyncio.Semaphore(5)

        async def guarded(src):
            async with sem:
                try:
                    return await read(llm, stats, question, src, model=step_models["reader"])
                except Exception as e:  # noqa: BLE001
                    return {
                        "id": src["id"], "relevance": 0, "summary": f"(read failed: {e})",
                        "quote": "", "facts": []
                    }

        done = 0
        for fut in asyncio.as_completed([guarded(s) for s in new]):
            note = await fut
            notes.append(note)
            done += 1
            yield {"type": "note", **note}
            yield stage("reader", "running", f"Read {done}/{len(new)}", "reader")
        yield stage("reader", "done", f"{len(notes)} sources analysed", "reader")

    async for ev in scout_and_read(p["sub_queries"], 1):
        yield ev

    if not sources:
        yield {"type": "error", "message": "No sources found. Check your network / search keys and try again."}
        return

    # 4. CRITIQUE -------------------------------------------------------
    relevant = sorted([n for n in notes if n["relevance"] >= 3], key=lambda n: -n["relevance"])
    yield stage("critic", "running", "Checking evidence coverage & gaps", "critic")
    c = await critique(llm, stats, question, relevant or notes, model=step_models["critic"])
    yield {"type": "critique", **c}
    yield stage("critic", "done", f"coverage {c['coverage']}/10", "critic")

    if deep and c["follow_up_queries"]:
        yield {"type": "plan", "angle": "Follow-up round to close identified gaps", "sub_queries": c["follow_up_queries"], "followup": True}
        async for ev in scout_and_read(c["follow_up_queries"], 2):
            yield ev
        relevant = sorted([n for n in notes if n["relevance"] >= 3], key=lambda n: -n["relevance"])

    evidence = relevant[:12] or sorted(notes, key=lambda n: -n["relevance"])[:8]

    # 5. WRITE (streamed, Ultra reasoning) --------------------------------
    yield stage("writer", "running", "Synthesizing research brief with reasoning", "writer")
    sys = (
        "You are the lead research analyst. Write a rigorous, authoritative research brief in GitHub Markdown "
        "answering the user question using ONLY the numbered evidence provided.\n"
        "Structure:\n"
        "- '# <title>'\n"
        "- bold **TL;DR** with 3 concise high-impact bullet points\n"
        "- '## Key Findings' with concrete data, numbers, and dates\n"
        "- '## Analysis' (cross-compare sources, note synergies or contradictions)\n"
        "- '## Limitations & Open Questions' (address gaps identified by the critic)\n"
        "- '## Bottom Line'\n"
        "MANDATORY: Cite every single factual assertion with bracketed source numbers like [2] or [1][4]. "
        "Never hallucinate facts or citation numbers. Aim for high density and analytical depth (~600-900 words)."
    )
    user = (
        f"QUESTION: {question}\nFOCUS MODE: {focus.upper()}\n\n"
        f"CRITIC GAPS TO ADDRESS: {'; '.join(c['gaps']) or 'none'}\n\n"
        f"VERIFIED EVIDENCE:\n{_evidence_block(sources, evidence)}"
    )
    t_w = time.perf_counter()
    first_token = None
    async for kind, delta in llm.stream(
        "ultra", [{"role": "system", "content": sys}, {"role": "user", "content": user}], stats,
        mock=lambda: _mock_report(question, sources, evidence, c["gaps"]), model=step_models["writer"],
    ):
        if first_token is None:
            first_token = time.perf_counter() - t_w
        yield {"type": "think" if kind == "think" else "report", "delta": delta}
    yield stage("writer", "done", "Report complete", "writer")

    # Complete snapshot payload so frontend can hold thread memory
    yield {
        "type": "done",
        "elapsed": round(time.perf_counter() - t_start, 2),
        "ttft_writer": round(first_token or 0, 2),
        "stats": stats.to_dict(),
        "n_sources": len(sources),
        "n_used": len(evidence),
        "notes": notes,
        "sources": {
            s["id"]: {
                "id": s["id"], "title": s["title"], "url": s["url"], "domain": s["domain"],
                "quote": next((n.get("quote", "") for n in notes if n["id"] == s["id"]), ""),
                "summary": next((n.get("summary", "") for n in notes if n["id"] == s["id"]), ""),
                "relevance": next((n.get("relevance", 0) for n in notes if n["id"] == s["id"]), 0),
                "bib_key": s.get("bib_key", f"ref{s['id']}"),
                "bibtex": s.get("bibtex", ""),
                "authors": s.get("authors", s.get("domain", "")),
                "doi": s.get("doi", ""),
                "venue": s.get("venue", s.get("domain", "")),
            } for s in sources.values()
        }
    }


# ---------------------------------------------------------------- follow-up Q&A agent
def _prior_sources_block(sources: dict) -> tuple[str, int]:
    """Formats the sources of the prior report; returns (text, highest source id)."""
    lines, max_id = [], 0
    for key, s in sources.items():
        if not isinstance(s, dict):
            continue
        try:
            sid = int(s.get("id", key))
        except (TypeError, ValueError):
            continue
        max_id = max(max_id, sid)
        quote = f' Quote: "{s["quote"]}"' if s.get("quote") else ""
        lines.append(f"[{sid}] {s.get('title', 'Untitled')} ({s.get('domain', '')}).{quote}")
    return "\n".join(lines), max_id


def _mock_followup(question: str, prior_question: str, sources: dict, new_hits: list[dict]) -> tuple[str, str]:
    think = (
        f"The user follows up on \"{prior_question}\" asking \"{question}\". "
        "Re-reading the prior brief and its verified quotes to answer with citations.\n"
    )
    cited = [s for s in sources.values() if isinstance(s, dict) and s.get("id")][:3]
    bullets = "\n".join(
        f"- {(s.get('summary') or s.get('quote') or s.get('title', ''))[:220]} [{s['id']}]" for s in cited
    ) or "- The prior brief does not contain direct evidence on this point."
    extra = "\n".join(f"- {h['title']} [{h['id']}]" for h in new_hits)
    text = (
        "> ⚠️ *Demo mode: generated without a Nebius API key.*\n\n"
        f"**Short answer:** based on the prior research, here is what the evidence says about *{question.rstrip('?')}*.\n\n"
        f"{bullets}\n"
        + (f"\n**Additional sources found:**\n{extra}\n" if extra else "")
    )
    return think, text


async def answer_followup(question: str, prior_question: str, prior_report: str,
                          sources: dict, llm: LLM, search: Search, focus: str = "web",
                          models: dict | None = None, provider: str | None = None) -> AsyncIterator[dict]:
    """Interactive follow-up conversation answering specific questions grounded in prior report and sources."""
    stats = RunStats()
    step_models = llm.step_models(models)

    # Determine if new search is needed or if prior evidence suffices
    eval_prompt = (
        f"You are an assistant evaluating if a follow-up user question can be answered from existing research.\n"
        f"PRIOR TOPIC: {prior_question}\n"
        f"FOLLOW-UP QUESTION: {question}\n\n"
        f"EXISTING REPORT EXCERPT:\n{prior_report[:2000]}\n\n"
        'Respond with ONLY JSON: {"needs_web_search": true/false, "search_query": "<if true, precise 4-8 word query, else empty>"}'
    )
    raw = await llm.chat("nano", [{"role": "user", "content": eval_prompt}], stats, max_tokens=250,
                         mock=lambda: '{"needs_web_search": false, "search_query": ""}', model=step_models["planner"])
    data = extract_json(raw) or {}
    needs_search = data.get("needs_web_search", False)
    if isinstance(needs_search, str):
        needs_search = needs_search.strip().lower() == "true"
    new_query = str(data.get("search_query") or "").strip()

    prior_sources_text, max_id = _prior_sources_block(sources)
    new_hits: list[dict] = []
    if needs_search is True and new_query:
        yield {"type": "followup_status", "status": f"Searching web for: '{new_query}'..."}
        for i, h in enumerate(await search.search(new_query, k=3, focus=focus, provider=provider), start=max_id + 1):
            h["id"] = i
            new_hits.append(h)
            yield {"type": "source", "source": {k: v for k, v in h.items() if k != "content"} | {"snippet": h["content"][:280]}}
    new_sources_text = (
        "\n\nADDITIONAL RECENT SOURCES:\n" + "\n".join(
            f"[{h['id']}] {h['title']} ({h['url']}): {h['content'][:1500]}" for h in new_hits
        ) if new_hits else ""
    )

    yield {"type": "followup_status", "status": "Nemotron Ultra is reasoning..."}

    sys = (
        "You are an interactive AI research assistant having a continuous conversation with the user. "
        "Answer the user's follow-up question specifically, concisely, and factually based on the research report "
        "and numbered sources provided. Maintain bracketed citations [n] matching the source numbers whenever "
        "referencing source material; never invent citation numbers. "
        "Format cleanly in Markdown with bold key takeaways."
    )
    user_msg = (
        f"ORIGINAL TOPIC: {prior_question}\n"
        f"PRIOR RESEARCH REPORT:\n{prior_report}\n"
        + (f"\nPRIOR SOURCES:\n{prior_sources_text}\n" if prior_sources_text else "")
        + f"{new_sources_text}\n\n"
        f"USER FOLLOW-UP QUESTION:\n{question}"
    )

    async for kind, delta in llm.stream(
        "ultra", [{"role": "system", "content": sys}, {"role": "user", "content": user_msg}], stats,
        max_tokens=3000, temperature=0.4,
        mock=lambda: _mock_followup(question, prior_question, sources, new_hits), model=step_models["writer"],
    ):
        yield {"type": "followup_delta", "kind": kind, "delta": delta}

    yield {"type": "followup_done", "stats": stats.to_dict()}


# ---------------------------------------------------------------- slide outline synthesizer
def _mock_slides(topic: str, report: str) -> str:
    import json
    sections = re.findall(r"^##\s+(.+?)\n(.*?)(?=^##\s|\Z)", report, flags=re.M | re.S)
    slides = []
    for title, body in sections[:5]:
        bullets = [re.sub(r"[*_`>]", "", b).strip() for b in re.findall(r"^[-*]\s+(.+)$", body, flags=re.M)]
        if not bullets:
            bullets = [s[:160] for s in _sentences(re.sub(r"[*_`>#]", "", body))]
        slides.append({"slide_number": len(slides) + 1, "title": title.strip(),
                       "bullets": bullets[:3] or ["See full report."], "takeaway": (bullets or [title])[0][:160]})
    return json.dumps({"title": topic, "subtitle": "Executive research briefing (demo mode)", "slides": slides})


async def generate_slides(topic: str, report: str, llm: LLM, models: dict | None = None) -> dict:
    """Synthesizes a 5-slide executive presentation outline based on the generated research."""
    stats = RunStats()
    sys = (
        "You are an executive communications director. Turn this detailed research report into a "
        "crisp 5-slide presentation outline for executive leadership.\n"
        'Respond with ONLY JSON matching this schema:\n'
        '{\n'
        '  "title": "<Deck title>",\n'
        '  "subtitle": "<Deck subtitle>",\n'
        '  "slides": [\n'
        '    {\n'
        '      "slide_number": 1,\n'
        '      "title": "<Slide title>",\n'
        '      "bullets": ["<Point 1>", "<Point 2>", "<Point 3>"],\n'
        '      "takeaway": "<One sentence key takeaway>"\n'
        '    }\n'
        '  ]\n'
        '}'
    )
    user = f"TOPIC: {topic}\n\nREPORT:\n{report[:6000]}"
    raw = await llm.chat("nano", [{"role": "system", "content": sys}, {"role": "user", "content": user}],
                         stats, max_tokens=1500, temperature=0.3,
                         mock=lambda: _mock_slides(topic, report), model=llm.step_models(models)["planner"])
    data = extract_json(raw) or {}
    return data
