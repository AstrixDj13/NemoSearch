"""Web search tools: Tavily with Focus Modes (Web, Academic, Finance, News) and keyless Wikipedia fallback."""
from __future__ import annotations

import asyncio
import logging
import os
from urllib.parse import urlparse

import httpx

log = logging.getLogger("paperpilot.search")
UA = {"User-Agent": (
    "PaperPilot/1.0 (https://nebiusglobalaihackathon.devpost.com/; "
    f"{os.getenv('CONTACT_EMAIL', 'paperpilot-hackathon@example.com')}) httpx/0.27"
)}

FOCUS_DOMAINS = {
    "academic": [
        "arxiv.org", "biorxiv.org", "medrxiv.org", "nature.com", "science.org",
        "sciencedirect.com", "ncbi.nlm.nih.gov", "semanticscholar.org", "ieee.org"
    ],
    "finance": [
        "sec.gov", "bloomberg.com", "reuters.com", "wsj.com", "ft.com",
        "finance.yahoo.com", "marketwatch.com", "cnbc.com"
    ],
    "news": [
        "reuters.com", "apnews.com", "bbc.com", "bloomberg.com", "theverge.com",
        "techcrunch.com", "arstechnica.com", "wired.com"
    ],
    "web": []
}


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.replace("www.", "")
    except Exception:  # noqa: BLE001
        return ""


_STOP = set("""a an the of in on for to and or vs versus how what why when which who whose is are was were be
been do does did can could should would will with by from as at into about over under between than that this
these those it its their there compared comparison during reduce reduces impact effect effects role using use
latest recent new evidence statistics study studies research analysis 2024 2025 2026""".split())


def _keywords(query: str, n: int = 4) -> str:
    words = [w.strip("?,.:;()\"'") for w in query.split()]
    return " ".join([w for w in words if w and w.lower() not in _STOP][:n])


class Search:
    def __init__(self) -> None:
        self.tavily_key = os.getenv("TAVILY_API_KEY", "").strip()
        self.provider = "tavily" if self.tavily_key else "wikipedia"
        self.client = httpx.AsyncClient(timeout=30, headers=UA)

    async def search(self, query: str, k: int = 4, focus: str = "web") -> list[dict]:
        try:
            if self.provider == "tavily":
                return await self._tavily(query, k, focus)
            return await self._wikipedia(query, k)
        except Exception as e:  # noqa: BLE001
            log.warning("search failed for %r (focus=%s): %s", query, focus, e)
            if self.provider == "tavily":
                try:
                    return await self._wikipedia(query, k)
                except Exception:  # noqa: BLE001
                    pass
            return []

    async def _tavily(self, query: str, k: int, focus: str) -> list[dict]:
        payload: dict = {
            "api_key": self.tavily_key,
            "query": query,
            "max_results": k,
            "search_depth": "advanced",
            "include_raw_content": False,
        }

        # Apply domain filters or news topic according to focus mode
        domains = FOCUS_DOMAINS.get(focus, [])
        if domains:
            payload["include_domains"] = domains

        if focus == "news":
            payload["topic"] = "news"
            payload["days"] = 7

        r = await self.client.post(
            "https://api.tavily.com/search",
            headers={"Authorization": f"Bearer {self.tavily_key}"},
            json=payload,
        )
        r.raise_for_status()
        out = []
        for item in r.json().get("results", []):
            content = (item.get("raw_content") or item.get("content") or "")[:7000]
            out.append({
                "title": item.get("title") or item.get("url"),
                "url": item.get("url", ""),
                "content": content,
                "domain": _domain(item.get("url", "")),
                "provider": "tavily",
                "focus": focus,
                "query": query,
            })
        return out

    async def _wiki_hits(self, query: str, k: int) -> list[dict]:
        r = await self.client.get("https://en.wikipedia.org/w/api.php", params={
            "action": "query", "list": "search", "srsearch": query,
            "srlimit": k, "format": "json",
        })
        r.raise_for_status()
        return r.json().get("query", {}).get("search", [])

    async def _wiki_page(self, pageid: int) -> dict:
        r = await self.client.get("https://en.wikipedia.org/w/api.php", params={
            "action": "query", "prop": "extracts|info", "inprop": "url",
            "explaintext": 1, "pageids": pageid, "format": "json",
        })
        r.raise_for_status()
        return r.json().get("query", {}).get("pages", {}).get(str(pageid), {})

    async def _wikipedia(self, query: str, k: int) -> list[dict]:
        hits = await self._wiki_hits(query, k)
        if len(hits) < 2:  # long natural-language queries rarely match; retry with keywords
            kw = _keywords(query)
            if kw and kw != query:
                seen = {h["pageid"] for h in hits}
                hits += [h for h in await self._wiki_hits(kw, k) if h["pageid"] not in seen]
        hits = hits[:k]
        pages = await asyncio.gather(*(self._wiki_page(h["pageid"]) for h in hits), return_exceptions=True)
        out = []
        for h, p in zip(hits, pages):
            if isinstance(p, Exception) or not p.get("extract"):
                continue
            url = p.get("fullurl", f"https://en.wikipedia.org/?curid={h['pageid']}")
            out.append({
                "title": p.get("title", h.get("title")),
                "url": url,
                "content": p["extract"][:6000],
                "domain": _domain(url),
                "provider": "wikipedia",
                "focus": "wiki",
                "query": query,
            })
        return out
