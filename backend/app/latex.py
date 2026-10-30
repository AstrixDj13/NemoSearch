"""NemoSearch In-App Academic Studio & LaTeX Paper Synthesis Engine:
Supports premier journal/conference templates (NeurIPS, ICML, ICLR, IEEE, ACM, Nature, Elsevier, Standard Article),
custom template installation, and complete publication-grade LaTeX paper compilation with matching BibTeX references.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from typing import Any

from .llm import LLM, RunStats

logger = logging.getLogger("nemosearch.latex")

# Built-in Premier Templates Registry
TEMPLATES: dict[str, dict[str, Any]] = {
    "neurips": {
        "id": "neurips",
        "name": "NeurIPS (Neural Information Processing Systems)",
        "venue": "Conference on Neural Information Processing Systems (NeurIPS)",
        "doc_class": "\\documentclass{article}",
        "preamble": r"""\usepackage[nonatbib]{neurips_2024}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{hyperref}
\usepackage{url}
\usepackage{booktabs}
\usepackage{amsfonts}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{nicefrac}
\usepackage{microtype}
\usepackage{xcolor}
\usepackage{graphicx}
\usepackage{algorithm}
\usepackage{algorithmic}""",
        "bib_style": "\\bibliographystyle{unsrt}\n\\bibliography{references}",
    },
    "icml": {
        "id": "icml",
        "name": "ICML (International Conference on Machine Learning)",
        "venue": "International Conference on Machine Learning (ICML)",
        "doc_class": "\\documentclass{article}",
        "preamble": r"""\usepackage{amsmath,amssymb}
\usepackage{hyperref}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{microtype}
\usepackage{subcaption}
\usepackage{geometry}
\geometry{margin=1in}""",
        "bib_style": "\\bibliographystyle{icml2024}\n\\bibliography{references}",
    },
    "iclr": {
        "id": "iclr",
        "name": "ICLR (International Conference on Learning Representations)",
        "venue": "International Conference on Learning Representations (ICLR)",
        "doc_class": "\\documentclass{article}",
        "preamble": r"""\usepackage{amsmath,amssymb}
\usepackage{hyperref}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{microtype}
\usepackage{url}
\usepackage{geometry}
\geometry{margin=1in}""",
        "bib_style": "\\bibliographystyle{iclr2024_conference}\n\\bibliography{references}",
    },
    "ieee": {
        "id": "ieee",
        "name": "IEEE Transactions / Conference",
        "venue": "IEEE Transactions on Pattern Analysis and Machine Intelligence / IEEE Access",
        "doc_class": "\\documentclass[journal,10pt,twocolumn]{IEEEtran}",
        "preamble": r"""\usepackage{cite}
\usepackage{amsmath,amssymb,amsfonts}
\usepackage{algorithmic}
\usepackage{graphicx}
\usepackage{textcomp}
\usepackage{booktabs}
\usepackage{hyperref}""",
        "bib_style": "\\bibliographystyle{IEEEtran}\n\\bibliography{references}",
    },
    "acm": {
        "id": "acm",
        "name": "ACM SIGCONF (Computer Science & AI)",
        "venue": "ACM Special Interest Group Conferences (SIGKDD / SIGIR / CHI)",
        "doc_class": "\\documentclass[sigconf,screen]{acmart}",
        "preamble": r"""\usepackage{booktabs}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{microtype}""",
        "bib_style": "\\bibliographystyle{ACM-Reference-Format}\n\\bibliography{references}",
    },
    "nature": {
        "id": "nature",
        "name": "Nature / Springer Nature Journal",
        "venue": "Nature Machine Intelligence / Springer Scientific Reports",
        "doc_class": "\\documentclass[sn-basic]{sn-jnl}",
        "preamble": r"""\usepackage{graphicx}
\usepackage{multirow}
\usepackage{amsmath,amssymb,amsfonts}
\usepackage{mathrsfs}
\usepackage{xcolor}
\usepackage{textcomp}
\usepackage{manyfoot}
\usepackage{booktabs}
\usepackage{algorithm}
\usepackage{algorithmicx}""",
        "bib_style": "\\bibliography{references}",
    },
    "elsevier": {
        "id": "elsevier",
        "name": "Elsevier (Artificial Intelligence / Pattern Recognition)",
        "venue": "Elsevier Journal of Artificial Intelligence Research",
        "doc_class": "\\documentclass[preprint,12pt]{elsarticle}",
        "preamble": r"""\usepackage{amssymb}
\usepackage{amsmath}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{lineno}
\usepackage{hyperref}""",
        "bib_style": "\\bibliographystyle{elsarticle-num}\n\\bibliography{references}",
    },
    "article": {
        "id": "article",
        "name": "Clean Academic Preprint (Generic Article)",
        "venue": "Preprint Repository / Working Paper",
        "doc_class": "\\documentclass[11pt,a4paper]{article}",
        "preamble": r"""\usepackage[utf8]{inputenc}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,amsfonts}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{hyperref}
\usepackage{microtype}
\hypersetup{colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue}""",
        "bib_style": "\\bibliographystyle{unsrt}\n\\bibliography{references}",
    },
}

def get_all_templates(custom: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Return the built-in templates plus one account's own (stored by store.Store.install_template)."""
    all_t = list(TEMPLATES.values()) + list(custom or [])
    return [
        {
            "id": t["id"],
            "name": t["name"],
            "venue": t.get("venue", ""),
            "custom": t.get("custom", False),
        }
        for t in all_t
    ]


def _paper_meta(s: dict[str, Any]) -> dict[str, Any]:
    return s.get("paper") if isinstance(s.get("paper"), dict) else {}


def _bib_escape(text: str) -> str:
    return re.sub(r"(?<!\\)([&%#_])", r"\\\1", " ".join(str(text).split()))


def cite_library(sources: list[dict[str, Any]] | dict[Any, Any]) -> list[dict[str, Any]]:
    """Gives every source one stable citation key and BibTeX entry. Drafting and every later revision use the
    same keys, so a key the text cites always exists in references.bib."""
    src_list = list(sources.values()) if isinstance(sources, dict) else list(sources or [])
    out: list[dict[str, Any]] = []
    used: set[str] = set()
    for idx, s in enumerate(src_list, start=1):
        if not isinstance(s, dict):
            continue
        meta = _paper_meta(s)
        authors = ", ".join(meta.get("authors") or []) or s.get("authors") or ""
        year = meta.get("year") or s.get("year") or ""
        key = s.get("bib_key") or ""
        if not key:
            surname = re.sub(r"[^a-zA-Z]", "", (authors.split(",")[0].split() or ["ref"])[-1]).lower() or "ref"
            key = f"{surname}{year or ''}{'' if year else idx}"
        base, n = key, 2
        while key in used:
            key, n = f"{base}{chr(ord('a') + n - 2)}", n + 1
        used.add(key)
        title = s.get("title") or "Untitled source"
        url = s.get("url") if s.get("url") not in (None, "#") else ""
        doi = meta.get("doi") or s.get("doi") or ""
        venue = meta.get("venue") or s.get("venue") or s.get("domain") or ""
        bibtex = s.get("bibtex") or "\n".join(
            [f"@{'article' if meta else 'misc'}{{{key},", f"  title     = {{{{{_bib_escape(title)}}}}},"]
            + ([f"  author    = {{{_bib_escape(authors.replace(', ', ' and '))}}},"] if authors else [])
            + ([f"  year      = {{{year}}},"] if year else [])
            + ([f"  journal   = {{{_bib_escape(venue)}}},"] if meta and venue else [])
            + ([f"  doi       = {{{doi}}},"] if doi else [])
            + ([f"  url       = {{{url}}},"] if url else [])
            + ["}"]
        )
        evidence = s.get("quote") or s.get("summary") or s.get("snippet") or ""
        out.append({"key": key, "title": title, "authors": authors, "year": year, "bibtex": bibtex,
                    "evidence": " ".join(str(evidence).split())})
    return out


def _evidence_text(library: list[dict[str, Any]], limit: int = 20, chars: int = 600) -> str:
    if not library:
        return "(No sources were saved with this research. Do not cite anything.)"
    return "\n".join(
        f"\\cite{{{c['key']}}}: {c['title']}" + (f" — {c['authors'][:120]}" if c["authors"] else "")
        + (f" ({c['year']})" if c["year"] else "") + (f"\n  Evidence: {c['evidence'][:chars]}" if c["evidence"] else "")
        for c in library[:limit]
    )


def _latex_escape(text: str) -> str:
    return re.sub(r"([&%$#_{}])", r"\\\1", " ".join(str(text).split()))


def author_block(authors: list[dict[str, str]]) -> str:
    """The \\author{...} block for the people writing the paper (the account, or the project's members)."""
    rows = [_latex_escape(a["name"]) + (f"\\\\\n  {_latex_escape(a['affiliation'])}" if a.get("affiliation") else "")
            for a in authors if a.get("name")]
    return "\\author{\n  " + ("\n  \\and\n  ".join(rows) or "Anonymous Authors") + "\n}"


def _materials(g: dict[str, Any], library: list[dict[str, Any]], brief_chars: int) -> str:
    """Everything that fixes what the paper is about, in the order the model should read it."""
    parts = [f"RESEARCH QUESTION (what the authors asked NemoSearch):\n{g['question'] or g['title']}"]
    if g.get("context"):
        parts.append(f"PROJECT CONTEXT (the project this paper belongs to):\n{g['context']}")
    brief = (g.get("brief") or "").strip()
    parts.append("RESEARCH BRIEF (NemoSearch's verified answer to the question; the paper's main material):\n"
                 + (brief[:brief_chars] if brief else "(No brief was saved. Write only what the sources support.)"))
    parts.append(f"SOURCES AND THEIR CITATION KEYS (cite only these keys):\n{_evidence_text(library)}")
    return "\n\n".join(parts)


GROUNDING_RULES = (
    "The paper's subject is fixed by the RESEARCH QUESTION, the PROJECT CONTEXT (when given) and the RESEARCH BRIEF. "
    "Every section must be about that subject. Never bring in fields, methods or examples that those materials do not mention.\n"
    "- If the question says \"this paper\" or \"this project\", it means the paper or project described in PROJECT CONTEXT. "
    "The new paper builds on that work; it is not a copy of it.\n"
    "- Support claims with the brief and the sources, citing them as \\cite{key} with only the listed keys.\n"
    "- Never invent results, numbers, datasets, experiments, benchmarks, equations of a method nobody proposed, or quotes. "
    "When the materials contain no experiments, write a review or position paper; a table is only for facts taken from the "
    "sources (for example comparing the cited studies).\n"
    "- Where the authors' own input is needed (their data, their results, a figure), leave a clearly marked "
    "\\textbf{[TODO: ...]} placeholder instead of making it up."
)


def _strip_fences(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    return re.sub(r"\s*```$", "", text).strip()


def _body_only(text: str) -> str:
    """The part between \\begin{document} and \\end{document} when a model wrote a whole document anyway."""
    m = re.search(r"\\begin\{document\}(.*?)(?:\\end\{document\}|\Z)", text, re.DOTALL)
    body = m.group(1) if m else text
    body = re.sub(r"\\bibliographystyle\{[^}]*\}|\\bibliography\{[^}]*\}", "", body)
    return body.strip()


def assemble(tpl: dict[str, Any], body: str) -> str:
    bib_style = tpl.get("bib_style", "\\bibliographystyle{unsrt}\n\\bibliography{references}")
    return f"{tpl['doc_class']}\n{tpl['preamble']}\n\n\\begin{{document}}\n\n{body.strip()}\n\n{bib_style}\n\n\\end{{document}}\n"


def resolve_template(template_id: str, custom_templates: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {t["id"]: t for t in custom_templates or []}.get(template_id) or TEMPLATES.get(template_id) or TEMPLATES["neurips"]


async def draft_paper(g: dict[str, Any], tpl: dict[str, Any], llm: LLM,
                      conversation: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Writes a full draft from the paper's grounding `g` (question, title, brief, sources, context, authors), following
    what the authors said in the chat so far. Returns the LaTeX, the BibTeX and the co-author's questions for them."""
    stats = RunStats()
    library = cite_library(g["sources"])
    authors = author_block(g["authors"])
    system = (
        "You are the co-author of an academic paper, writing its first draft in LaTeX for the human authors.\n"
        + GROUNDING_RULES + "\n"
        "Structure: \\title{...}, then the AUTHOR BLOCK exactly as given, \\maketitle, an abstract, an Introduction, sections whose "
        "headings suit this subject, a section on limitations and open questions, and a Conclusion.\n"
        "Output the LaTeX body only: from \\title to the end of the last section. No \\documentclass, preamble, "
        "\\begin{document}, bibliography commands or \\end{document}, and no markdown fences.\n"
        "After the LaTeX, on a new line, write <questions> then two or three short questions that would help the authors steer "
        "the next revision (for example which contribution to stress, the target audience, or results of their own to add), "
        "then </questions>."
    )
    chat = "\n".join(f"{m['speaker']}: {m['text']}" for m in (conversation or [])[-14:])
    directions = f"\n\nTHE AUTHORS' DIRECTIONS (their chat with you so far; follow what they asked for):\n{chat}" if chat else ""
    user = (f"{_materials(g, library, 9000)}{directions}\n\nAUTHOR BLOCK:\n{authors}\n\n"
            f"TARGET VENUE: {tpl['name']} ({tpl.get('venue', '')})\n\nWrite the draft now.")

    def mock() -> str:
        cites = " ".join(f"\\cite{{{c['key']}}}" for c in library[:3])
        brief = _latex_escape((g.get("brief") or "").strip()[:900]) or "The saved research has no brief yet."
        return (f"\\title{{{_latex_escape(g['title'])}}}\n{authors}\n\\maketitle\n\n\\begin{{abstract}}\n"
                f"This paper reviews what is known about {_latex_escape(g['title'])}. {cites}\n\\end{{abstract}}\n\n"
                f"\\section{{Introduction}}\n{brief}\n\n\\section{{What the Literature Shows}}\n"
                f"The sources gathered for this question are summarised here {cites}.\n\n"
                "\\section{Limitations and Open Questions}\n\\textbf{[TODO: the authors' own perspective]}\n\n"
                "\\section{Conclusion}\nThe evidence above frames the next steps.\n\n"
                "<questions>Which contribution should the paper stress? Who is the audience?</questions>")

    raw = await llm.chat("ultra", [{"role": "system", "content": system}, {"role": "user", "content": user}],
                         stats, max_tokens=7000, temperature=0.3, mock=mock)
    raw = _strip_fences(raw)
    questions = ""
    m = re.search(r"<questions>(.*?)(?:</questions>|\Z)", raw, re.DOTALL)
    if m:
        questions = " ".join(m.group(1).split())
        raw = raw[:m.start()]
    return {
        "latex": assemble(tpl, _body_only(_strip_fences(raw))),
        "bibtex": "\n\n".join(c["bibtex"] for c in library),
        "questions": questions,
        "stats": stats.to_dict(),
    }


MAX_PAPER_CHARS = 60_000


async def coauthor_turn(g: dict[str, Any], latex: str, conversation: list[dict[str, str]], llm: LLM) -> dict[str, Any]:
    """One reply in the shared chat. The co-author either answers or asks, or revises the paper and says what changed.
    `conversation` is the recent chat, oldest first, as {"speaker", "text"}. Returns {"reply", "latex" (None when
    the paper was not changed)}."""
    stats = RunStats()
    library = cite_library(g["sources"])
    names = ", ".join(a["name"] for a in g["authors"] if a.get("name")) or "the authors"
    system = (
        f"You are the co-author in a live writing session with the human authors of a LaTeX paper ({names}). "
        "They talk to you, and to each other, in a shared chat; the newest message is the one to act on.\n"
        + GROUNDING_RULES + "\n"
        "Each turn, do one of these:\n"
        "- When the request is clear, revise the paper and say in a sentence or two what you changed.\n"
        "- When it is ambiguous, or needs something only the authors know (their results, data, framing), ask one short, "
        "specific question instead of guessing. Also ask when authors disagree, naming who said what.\n"
        "- When they only ask a question, answer it from the paper and the materials.\n"
        "Keep the preamble, the author block and existing citations unless asked otherwise, and change only what the request needs.\n"
        + ("Nothing is drafted yet, so do not write the paper. Agree on the plan with the authors (focus, angle, audience, "
           "anything of their own to include) and tell them to select Draft paper when they are ready.\n"
           if not latex.strip() else "")
        + "Output format, exactly:\n<reply>your chat message (plain text, no LaTeX, a few sentences at most)</reply>\n"
        "and only if you changed the paper, after it:\n<latex>the COMPLETE updated document from \\documentclass to "
        "\\end{document}</latex>"
    )
    chat = "\n".join(f"{m['speaker']}: {m['text']}" for m in conversation[-14:])
    user = (f"{_materials(g, library, 6000)}\n\nCURRENT PAPER:\n{latex[:MAX_PAPER_CHARS] or '(empty: nothing drafted yet)'}"
            f"\n\nCHAT SO FAR (oldest first):\n{chat}")

    def mock() -> str:
        last = conversation[-1]["text"] if conversation else ""
        if not latex.strip() or last.rstrip().endswith("?"):
            return f"<reply>About \"{last[:80]}\": the brief covers this; tell me which section you'd like it in.</reply>"
        revised = latex.replace("\\section{Conclusion}", f"% Revised: {last[:80]}\n\\section{{Conclusion}}", 1)
        return f"<reply>Done: I worked \"{last[:80]}\" into the paper before the conclusion.</reply>\n<latex>{revised}</latex>"

    raw = await llm.chat("ultra", [{"role": "system", "content": system}, {"role": "user", "content": user}],
                         stats, max_tokens=12000, temperature=0.3, mock=mock)
    reply_m = re.search(r"<reply>(.*?)(?:</reply>|<latex>|\Z)", raw, re.DOTALL)
    latex_m = re.search(r"<latex>(.*?)(?:</latex>|\Z)", raw, re.DOTALL)
    reply = (reply_m.group(1) if reply_m else re.sub(r"<latex>.*", "", raw, flags=re.DOTALL)).strip()
    new_latex = None
    if latex_m:
        candidate = _strip_fences(latex_m.group(1))
        if "\\end{document}" not in candidate or "\\begin{document}" not in candidate:
            # A revision cut off by the length limit would silently drop the end of the paper
            reply = (reply + "\n\n" if reply else "") + ("My revision was cut off before the end of the paper, so I didn't "
                                                         "apply it. Ask for a smaller change, or one section at a time.")
        elif latex.strip() and candidate.strip() != latex.strip():  # before a draft, Draft paper writes it
            new_latex = candidate.strip() + "\n"
    return {"reply": reply or "I couldn't produce an answer to that. Could you rephrase it?", "latex": new_latex,
            "stats": stats.to_dict()}


def create_latex_zip(topic: str, latex_content: str, bibtex_content: str) -> bytes:
    """Package main.tex, references.bib, sections/, styles/, and README into a ready-to-submit ZIP package."""
    zip_buffer = io.BytesIO()
    clean_slug = re.sub(r"[^a-zA-Z0-9_-]", "_", topic.lower())[:30]

    readme = f"""# {topic} - Academic Research Paper Package
Generated autonomously by NemoSearch (NVIDIA Nemotron 3 Ensemble + OpenAlex/arXiv).

## Overleaf / Project File Structure
- `main.tex`: Compilable master LaTeX manuscript.
- `references.bib`: Grounded BibTeX reference database.
- `sections/`: Modular section files:
  - `01_introduction.tex`
  - `02_related_work.tex`
  - `03_methodology.tex`
  - `04_experiments.tex`
- `styles/`: Venue class and style definitions (e.g. `neurips_2024.sty`, `IEEEtran.cls`).
- `README.md`: Compilation and submission instructions.

## Compilation Instructions
Compile with standard TeX distributions (TeXLive, MacTeX, MiKTeX) or Overleaf:
```bash
pdflatex main.tex
bibtex main
pdflatex main.tex
pdflatex main.tex
```
Or drag this zip file directly into Overleaf via 'New Project -> Upload Project'.
"""

    # sections/ holds the paper's first four sections in order, whatever their headings
    found = re.findall(r"(\\section\*?\{[\s\S]*?)(?=\\section\*?\{|\\bibliographystyle|\\bibliography\{|\\end\{document\}|\Z)",
                       latex_content)

    def nth_section(i: int) -> str:
        return found[i].strip() if i < len(found) else f"% This paper has fewer than {i + 1} sections.\n"

    intro_sec, related_sec, method_sec, exp_sec = (nth_section(i) for i in range(4))

    sty_content = """% Standard NeurIPS Conference Package
\\NeedsTeXFormat{LaTeX2e}
\\ProvidesPackage{neurips_2024}[2024/02/01 NeurIPS 2024 submission style file]
\\RequirePackage{amsmath,amssymb,amsfonts}
\\RequirePackage{graphicx}
\\RequirePackage{booktabs}
\\RequirePackage{hyperref}
\\typeout{NemoSearch Academic Template Engine Loaded}
"""

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("main.tex", latex_content)
        zf.writestr("references.bib", bibtex_content)
        zf.writestr("README.md", readme)
        zf.writestr("sections/01_introduction.tex", intro_sec)
        zf.writestr("sections/02_related_work.tex", related_sec)
        zf.writestr("sections/03_methodology.tex", method_sec)
        zf.writestr("sections/04_experiments.tex", exp_sec)
        zf.writestr("styles/neurips_2024.sty", sty_content)

    zip_buffer.seek(0)
    return zip_buffer.getvalue()
