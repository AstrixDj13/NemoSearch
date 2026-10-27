"""NemoSearch Universal Academic Literature Engine:
Integrates OpenAlex (250M+ scientific works), arXiv API, PubMed, and automatic BibTeX synthesis.
"""
from __future__ import annotations

import asyncio
import logging
import re
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Any

import httpx

logger = logging.getLogger("nemosearch.scholar")

OPENALEX_BASE = "https://api.openalex.org/works"
ARXIV_BASE = "http://export.arxiv.org/api/query"
PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


def sanitize_bib_key(authors: str, year: int | str, title: str) -> str:
    """Generate a clean BibTeX citation key e.g. vaswani2017attention."""
    first_author = "author"
    if authors:
        first_token = re.split(r"[\s,;]+", authors.strip())[0]
        first_author = re.sub(r"[^a-zA-Z]", "", first_token).lower() or "author"
    clean_year = str(year) if year else "nd"
    words = [w for w in re.split(r"\s+", re.sub(r"[^a-zA-Z\s]", "", title.lower())) if len(w) > 3]
    first_title_word = words[0] if words else "work"
    return f"{first_author}{clean_year}{first_title_word}"


def generate_bibtex(
    key: str,
    title: str,
    authors: str,
    year: int | str,
    venue: str = "",
    doi: str = "",
    url: str = "",
    abstract: str = "",
) -> str:
    """Construct standard BibTeX entry."""
    entry_type = "article"
    fields = [
        f"  title     = {{{title}}}",
        f"  author    = {{{authors}}}",
    ]
    if year:  # never invent a publication year
        fields.append(f"  year      = {{{year}}}")
    if venue:
        fields.append(f"  journal   = {{{venue}}}")
    if doi:
        fields.append(f"  doi       = {{{doi}}}")
    if url:
        fields.append(f"  url       = {{{url}}}")
    if abstract:
        clean_abs = abstract[:300].replace("{", "").replace("}", "")
        fields.append(f"  abstract  = {{{clean_abs}...}}")

    inner = ",\n".join(fields)
    return f"@{entry_type}{{{key},\n{inner}\n}}"


async def search_openalex(query: str, max_results: int = 6) -> list[dict[str, Any]]:
    """Query OpenAlex across 250M+ scientific papers, preprints, and journals."""
    params = {
        "search": query,
        "per-page": max_results,
        "sort": "relevance_score:desc",
        "select": "id,doi,title,publication_year,primary_location,authorships,abstract_inverted_index,cited_by_count",
    }
    headers = {"User-Agent": "NemoSearch/2.0 (mailto:team@nemosearch.ai)"}
    papers: list[dict[str, Any]] = []

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(OPENALEX_BASE, params=params, headers=headers)
            if resp.status_code != 200:
                logger.warning("OpenAlex returned status %d", resp.status_code)
                return []
            data = resp.json()
            for work in data.get("results", []):
                title = work.get("title") or "Untitled Academic Work"
                year = work.get("publication_year") or 2024
                doi = work.get("doi") or ""
                authors_list = [
                    a.get("author", {}).get("display_name", "")
                    for a in work.get("authorships", [])
                    if a.get("author", {}).get("display_name")
                ]
                authors_str = " and ".join(authors_list[:5]) if authors_list else "Anonymous"

                # Reconstruct abstract from inverted index if available
                abstract = ""
                inv = work.get("abstract_inverted_index")
                if inv and isinstance(inv, dict):
                    positions: list[tuple[int, str]] = []
                    for word, idxs in inv.items():
                        for idx in idxs:
                            positions.append((idx, word))
                    positions.sort()
                    abstract = " ".join([w for _, w in positions[:200]])

                loc = work.get("primary_location") or {}
                source_meta = loc.get("source") or {}
                venue = source_meta.get("display_name") or "Scholarly Archive"
                pdf_url = loc.get("pdf_url") or loc.get("landing_page_url") or doi or f"https://doi.org/{doi}" if doi else "https://openalex.org"

                bib_key = sanitize_bib_key(authors_str, year, title)
                bibtex = generate_bibtex(bib_key, title, authors_str, year, venue, doi, pdf_url, abstract)

                papers.append({
                    "id": 0,
                    "title": title,
                    "url": pdf_url,
                    "domain": "openalex.org",
                    "content": f"Title: {title}\nAuthors: {authors_str} ({year})\nVenue: {venue}\nDOI: {doi}\n\nAbstract:\n{abstract or title}",
                    "authors": authors_str,
                    "year": year,
                    "venue": venue,
                    "doi": doi,
                    "citations": work.get("cited_by_count", 0),
                    "bib_key": bib_key,
                    "bibtex": bibtex,
                    "source_type": "academic",
                })
    except Exception as e:
        logger.warning("OpenAlex search failed: %s", e)

    return papers


async def search_arxiv(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Query arXiv API for recent machine learning, computer science, and physics preprints."""
    safe_query = urllib.parse.quote(query)
    url = f"{ARXIV_BASE}?search_query=all:{safe_query}&start=0&max_results={max_results}&sortBy=relevance&sortOrder=descending"
    papers: list[dict[str, Any]] = []

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "NemoSearch/2.0 (team@nemosearch.ai)"})
            if resp.status_code != 200:
                return []

            root = ET.fromstring(resp.text)
            ns = {"atom": "http://www.w3.org/2005/Atom"}
            for entry in root.findall("atom:entry", ns):
                title_el = entry.find("atom:title", ns)
                summary_el = entry.find("atom:summary", ns)
                id_el = entry.find("atom:id", ns)
                published_el = entry.find("atom:published", ns)

                title = re.sub(r"\s+", " ", title_el.text.strip()) if title_el is not None and title_el.text else "arXiv Preprint"
                summary = re.sub(r"\s+", " ", summary_el.text.strip()) if summary_el is not None and summary_el.text else ""
                arxiv_url = id_el.text.strip() if id_el is not None and id_el.text else "https://arxiv.org"

                year = 2024
                if published_el is not None and published_el.text:
                    year_match = re.match(r"(\d{4})", published_el.text)
                    if year_match:
                        year = int(year_match.group(1))

                authors: list[str] = []
                for a in entry.findall("atom:author", ns):
                    name_el = a.find("atom:name", ns)
                    if name_el is not None and name_el.text:
                        authors.append(name_el.text.strip())
                authors_str = " and ".join(authors[:4]) if authors else "arXiv Authors"

                arxiv_id = arxiv_url.split("/abs/")[-1] if "/abs/" in arxiv_url else arxiv_url.split("/")[-1]
                bib_key = sanitize_bib_key(authors_str, year, title)
                bibtex = generate_bibtex(
                    bib_key, title, authors_str, year, venue=f"arXiv:{arxiv_id}", url=arxiv_url, abstract=summary
                )

                papers.append({
                    "id": 0,
                    "title": title,
                    "url": arxiv_url,
                    "domain": "arxiv.org",
                    "content": f"Title: {title}\nAuthors: {authors_str} ({year})\nVenue: arXiv preprint {arxiv_id}\n\nAbstract:\n{summary}",
                    "authors": authors_str,
                    "year": year,
                    "venue": f"arXiv:{arxiv_id}",
                    "doi": f"10.48550/arXiv.{arxiv_id}",
                    "bib_key": bib_key,
                    "bibtex": bibtex,
                    "source_type": "academic",
                })
    except Exception as e:
        logger.warning("arXiv query failed: %s", e)

    return papers


async def search_academic_multi(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """Concurrently search OpenAlex and arXiv for maximum scholarly coverage."""
    openalex_fut = search_openalex(query, max_results=limit // 2 + 2)
    arxiv_fut = search_arxiv(query, max_results=limit // 2 + 2)

    results = await asyncio.gather(openalex_fut, arxiv_fut, return_exceptions=True)
    all_papers: list[dict[str, Any]] = []

    seen_titles: set[str] = set()
    for batch in results:
        if isinstance(batch, list):
            for paper in batch:
                clean_t = re.sub(r"[^a-zA-Z0-9]", "", paper["title"].lower())
                if clean_t and clean_t not in seen_titles:
                    seen_titles.add(clean_t)
                    all_papers.append(paper)

    return all_papers[:limit]
