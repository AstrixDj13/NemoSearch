"""NemoSearch In-App Academic Studio & LaTeX Paper Synthesis Engine:
Supports premier journal/conference templates (NeurIPS, ICML, ICLR, IEEE, ACM, Nature, Elsevier, Standard Article),
custom template installation, and complete publication-grade LaTeX paper compilation with matching BibTeX references.
"""
from __future__ import annotations

import io
import json
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

# In-memory custom user templates (custom .cls or .sty uploaded by researchers)
CUSTOM_TEMPLATES: dict[str, dict[str, Any]] = {}


def get_all_templates() -> list[dict[str, Any]]:
    """Return all built-in and user-installed LaTeX templates."""
    all_t = list(TEMPLATES.values()) + list(CUSTOM_TEMPLATES.values())
    return [
        {
            "id": t["id"],
            "name": t["name"],
            "venue": t.get("venue", ""),
            "custom": t.get("custom", False),
        }
        for t in all_t
    ]


def install_custom_template(name: str, doc_class: str, preamble: str, venue: str = "") -> dict[str, Any]:
    """Register a custom journal/conference LaTeX template uploaded or defined by the researcher."""
    template_id = "custom_" + re.sub(r"[^a-zA-Z0-9_]", "", name.lower().replace(" ", "_"))
    entry = {
        "id": template_id,
        "name": name,
        "venue": venue or "Custom Journal / Conference Template",
        "doc_class": doc_class or "\\documentclass[11pt]{article}",
        "preamble": preamble or "\\usepackage{amsmath,amssymb,graphicx,booktabs,hyperref}",
        "bib_style": "\\bibliographystyle{unsrt}\n\\bibliography{references}",
        "custom": True,
    }
    CUSTOM_TEMPLATES[template_id] = entry
    return entry


async def generate_latex_paper(
    topic: str,
    report: str,
    sources: list[dict[str, Any]] | dict[int | str, Any],
    template_id: str,
    llm: LLM,
    custom_preamble: str = "",
) -> dict[str, Any]:
    """Use Nemotron Ultra 550B to write a complete academic LaTeX paper grounded in verified sources."""
    stats = RunStats()

    # Resolve template
    tpl = CUSTOM_TEMPLATES.get(template_id) or TEMPLATES.get(template_id) or TEMPLATES["neurips"]
    doc_class = tpl["doc_class"]
    preamble = custom_preamble if custom_preamble.strip() else tpl["preamble"]
    bib_style = tpl.get("bib_style", "\\bibliographystyle{unsrt}\n\\bibliography{references}")

    # Normalize sources and build BibTeX library
    src_list: list[dict[str, Any]] = []
    if isinstance(sources, dict):
        src_list = list(sources.values())
    elif isinstance(sources, list):
        src_list = sources

    bib_entries: list[str] = []
    evidence_blocks: list[str] = []

    for idx, s in enumerate(src_list, start=1):
        bib_key = s.get("bib_key")
        if not bib_key:
            first_author = s.get("authors") or s.get("domain") or "ref"
            first_author = re.sub(r"[^a-zA-Z]", "", first_author.split()[0]).lower() or f"ref{idx}"
            bib_key = f"{first_author}{idx}"

        title = s.get("title") or "Scholarly Article"
        authors = s.get("authors") or s.get("domain") or "Research Team"
        quote = s.get("quote") or s.get("snippet") or s.get("summary") or ""
        url = s.get("url") or ""

        bib_text = s.get("bibtex")
        if not bib_text:
            bib_text = f"""@article{{{bib_key},
  title     = {{{title}}},
  author    = {{{authors}}},
  year      = {{2024}},
  url       = {{{url}}}
}}"""
        bib_entries.append(bib_text)
        evidence_blocks.append(f"[{idx}] Citation Key: \\cite{{{bib_key}}}\nTitle: {title}\nAuthor: {authors}\nVerbatim Evidence: {quote}\n")

    bibtex_combined = "\n\n".join(bib_entries)
    evidence_prompt_text = "\n".join(evidence_blocks[:15])

    sys = (
        "You are an elite academic professor and lead researcher publishing in top scientific venues (NeurIPS, ICML, IEEE, Nature).\n"
        "Write a complete, mathematically rigorous, publication-grade academic research paper in standard LaTeX format.\n"
        "MANDATORY REQUIREMENTS:\n"
        "1. Structure your output with standard sections:\n"
        "   - \\title{...}, \\author{NemoSearch Autonomous Research Engine \\\\ \\texttt{research@nemosearch.ai}}\n"
        "   - \\begin{abstract} ... \\end{abstract}\n"
        "   - \\section{Introduction} (Problem statement, motivations, and itemized contributions)\n"
        "   - \\section{Related Work} (Thorough comparison with cited literature using \\cite{key})\n"
        "   - \\section{Theoretical Formulation and Methodology} (Include formal LaTeX mathematical equations \\begin{equation} ... \\end{equation} or algorithm definitions)\n"
        "   - \\section{Analytical Findings and Evaluation} (Synthesize quantitative evidence, include a neat LaTeX table comparing approaches or metrics)\n"
        "   - \\section{Discussion, Limitations, and Open Problems} (Address critical trade-offs and research frontiers)\n"
        "   - \\section{Conclusion}\n"
        "2. CITATIONS: Use ONLY the provided Citation Keys (e.g., \\cite{key}) to ground all claims.\n"
        "3. Output ONLY the LaTeX code from \\title{...} to \\end{document}. Do NOT wrap with markdown backticks."
    )

    user = f"""RESEARCH TOPIC:
{topic}

SYNTHESIZED RESEARCH BRIEF:
{report[:3500]}

VERIFIED SCHOLARLY EVIDENCE AND CITATION KEYS:
{evidence_prompt_text}

TARGET VENUE / TEMPLATE:
{tpl['name']} ({tpl.get('venue', '')})

Write the complete paper now in LaTeX."""

    def mock_paper() -> str:
        first_key = "ref1" if not bib_entries else re.search(r"@\w+\{([^,]+),", bib_entries[0]).group(1)
        return f"""\\title{{{topic}: An Analytical Survey and Methodological Framework}}
\\author{{
  NemoSearch Autonomous Research Group\\\\
  Nebius AI Cloud \\& NVIDIA Nemotron Ensemble\\\\
  \\texttt{{research@nemosearch.ai}}
}}
\\date{{\\today}}

\\maketitle

\\begin{{abstract}}
In this work, we present a comprehensive analytical investigation into \\textbf{{{topic}}}. Driven by recent theoretical advancements and empirical breakthroughs, we synthesize foundational principles, systematically evaluate serving and algorithmic constraints, and introduce a formalized methodological architecture. Grounded in primary empirical literature \\cite{{{first_key}}}, our analysis demonstrates the trade-offs between parameter efficiency, routing complexity, and compute allocation across high-throughput workloads.
\\end{{abstract}}

\\section{{Introduction}}
Recent developments in large-scale computational systems have accelerated interest in {topic}. Traditional paradigms often assume uniform scaling dynamics; however, real-world deployment across distributed clusters introduces heterogeneous bottlenecks in memory bandwidth, IO latency, and synchronization overhead \\cite{{{first_key}}}.

Our primary contributions are threefold:
\\begin{{itemize}}
  \\item We conduct a rigorous synthesis of current empirical literature addressing {topic}.
  \\item We formalize the operational trade-offs through a closed-form analytical model.
  \\item We identify critical limitations and articulate concrete frontiers for future autonomous systems.
\\end{{itemize}}

\\section{{Related Work}}
Scholarly exploration in this domain traces back to foundational architectures \\cite{{{first_key}}}. Recent studies emphasize IO-awareness, communication-efficient parallelization, and adaptive gating networks. Unlike prior static reviews, our investigation directly couples theoretical bounds with hardware-level metrics.

\\section{{Methodological Formulation}}
Let $\\mathcal{{M}}$ represent the inference system parameterized by $\\theta \\in \\mathbb{{R}}^D$. The effective computational cost per input token $x$ is defined as:
\\begin{{equation}}
  \\mathcal{{C}}(x) = \\sum_{{k=1}}^{{K}} g_k(x) \\cdot \\Phi_k(x; \\theta_k) + \\Omega(\\text{{routing}}),
\\end{{equation}}
where $g_k(x) \\in [0, 1]$ represents the top-$k$ gating routing probability and $\\Omega$ models the interconnect communication penalty.

\\section{{Empirical Evaluation and Comparative Analysis}}
Table~\\ref{{tab:comparison}} outlines the comparative performance characteristics synthesized across verified benchmark records.

\\begin{{table}}[h]
\\centering
\\caption{{Synthesized Performance Metrics Across Computational Modalities}}
\\label{{tab:comparison}}
\\begin{{tabular}}{{lcccc}}
\\toprule
\\textbf{{Architecture}} & \\textbf{{Active FLOPs}} & \\textbf{{Routing Overhead}} & \\textbf{{Memory Bound}} \\\\
\\midrule
Dense Baseline          & $1.0\\times$ & $0\\%$   & Predictable \\\\
Sparse Routing (MoE)   & $0.28\\times$ & $14\\%$ & Interconnect \\\\
IO-Aware Adaptive       & $0.32\\times$ & $6\\%$  & Cache-Optimized \\\\
\\bottomrule
\\end{{tabular}}
\\end{{table}}

\\section{{Discussion and Limitations}}
While theoretical savings indicate substantial efficiency improvements, practical hardware deployment must account for batch-size variations and memory bandwidth bounds \\cite{{{first_key}}}. 

\\section{{Conclusion}}
We have investigated {topic} using a multi-agent evidence synthesis pipeline. Future extensions will incorporate real-time compiler optimizations and adaptive inference routing.
"""

    raw_body = await llm.chat(
        "ultra",
        [{"role": "system", "content": sys}, {"role": "user", "content": user}],
        stats,
        max_tokens=2800,
        temperature=0.3,
        mock=mock_paper,
    )

    clean_body = raw_body.strip()
    if clean_body.startswith("```latex"):
        clean_body = clean_body[8:]
    elif clean_body.startswith("```"):
        clean_body = clean_body[3:]
    if clean_body.endswith("```"):
        clean_body = clean_body[:-3]
    clean_body = clean_body.strip()

    # Strip existing documentclass/preamble if Ultra emitted it inside the body
    if "\\documentclass" in clean_body:
        body_match = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", clean_body, re.DOTALL)
        if body_match:
            clean_body = body_match.group(1).strip()
        else:
            clean_body = re.sub(r"\\documentclass.*?\\begin\{document\}", "", clean_body, flags=re.DOTALL).strip()
            clean_body = clean_body.replace("\\end{document}", "").strip()

    # Assemble complete compilable LaTeX document
    full_latex = f"""{doc_class}
{preamble}

\\begin{{document}}

{clean_body}

{bib_style}

\\end{{document}}
"""

    return {
        "template": tpl,
        "topic": topic,
        "latex": full_latex,
        "bibtex": bibtex_combined,
        "stats": stats.to_dict(),
    }


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

    # Section modular helpers
    def extract_section(name: str, fallback: str) -> str:
        pattern = rf"(\\section\{{{name}\}}[\s\S]*?)(?=\\section\{{|\\bibliography|\Z)"
        m = re.search(pattern, latex_content, re.IGNORECASE)
        return m.group(1).strip() if m else fallback

    intro_sec = extract_section("Introduction", f"% Introduction for {topic}\n\\section{{Introduction}}\nThis paper investigates {topic}.")
    related_sec = extract_section("Related Work", f"% Related Work for {topic}\n\\section{{Related Work}}\nWe review prior foundational literature.")
    method_sec = extract_section("Theoretical Formulation and Methodology", f"% Methodology for {topic}\n\\section{{Theoretical Formulation and Methodology}}\nWe formalize the mathematical framework.")
    exp_sec = extract_section("Analytical Findings and Evaluation", f"% Evaluation for {topic}\n\\section{{Analytical Findings and Evaluation}}\nEmpirical results across benchmark suites.")

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


async def refine_latex_paper(
    topic: str,
    current_latex: str,
    instruction: str,
    sources: list[dict[str, Any]] | dict[int | str, Any],
    llm: LLM,
    report: str = "",
) -> dict[str, Any]:
    """Human-in-the-loop AI Co-Author: Intelligently expands, modifies, or writes sections of the paper based on researcher guidance."""
    stats = RunStats()

    src_list: list[dict[str, Any]] = []
    if isinstance(sources, dict):
        src_list = list(sources.values())
    elif isinstance(sources, list):
        src_list = sources

    evidence_snippets = "\n".join(
        f"- \\cite{{{s.get('bib_key', f'ref{idx}')}}}: {s.get('title', '')} (Evidence: {s.get('quote', s.get('snippet', ''))[:160]})"
        for idx, s in enumerate(src_list[:15], start=1)
    )

    sys = (
        "You are an elite scientific AI co-author collaborating with a human researcher on a publication-grade LaTeX manuscript.\n"
        "Your task is to revise, expand, or write sections of the provided LaTeX manuscript following the researcher's exact instruction.\n"
        "MANDATORY RULES:\n"
        "1. Obey the researcher's steering instructions precisely. If asked to write a 3-page or comprehensive paper, thoroughly expand and flesh out all sections (Introduction, Related Work, Theoretical Formulation, Empirical Evaluation with Tables, Discussion, and Conclusion) with deep content.\n"
        "2. Ground assertions using the verified \\cite{key} keys provided from primary literature.\n"
        "3. Synthesize the provided deep research findings into the text, equations, and tables.\n"
        "4. Preserve all existing valid LaTeX packages, preamble, and overall structure.\n"
        "5. Output the COMPLETE updated compilable LaTeX code from \\documentclass to \\end{document}. Do NOT wrap with markdown backticks."
    )

    user = f"""RESEARCH TOPIC:
{topic}

RESEARCHER'S STEERING INSTRUCTION:
{instruction}

DEEP RESEARCH REPORT & FINDINGS:
{report[:7000] if report.strip() else 'Refer to verified literature and current manuscript.'}

VERIFIED PRIMARY EVIDENCE & CITATIONS:
{evidence_snippets}

CURRENT LATEX MANUSCRIPT:
{current_latex[:7000]}

Apply the researcher's instructions and output the complete updated LaTeX code now. Write out all sections thoroughly with complete academic prose, mathematical formulations, tables, and citations."""

    def mock_refine():
        if "\\section{Methodological Formulation}" in current_latex:
            addition = f"""\n\n% --- Human-in-the-loop expansion: {instruction} ---
\\subsection{{Operational Bounds and Scaling Analysis}}
Guided by researcher steering regarding \\textit{{{instruction}}}, we formalize the operational boundaries for {topic}. 
Under high-concurrency workloads, the memory access penalty $\\beta \\cdot \\text{{MemoryAccess}}(x)$ dominates FLOP scaling, requiring IO-aware hierarchical caching.
"""
            return current_latex.replace(
                "\\section{Methodological Formulation}",
                "\\section{Methodological Formulation}" + addition
            )
        return current_latex + f"\n% Refined per instruction: {instruction}\n"

    raw_body = await llm.chat(
        "ultra",
        [{"role": "system", "content": sys}, {"role": "user", "content": user}],
        stats,
        max_tokens=5500,
        temperature=0.3,
        mock=mock_refine,
    )

    clean_latex = raw_body.strip()
    if clean_latex.startswith("```latex"):
        clean_latex = clean_latex[8:]
    elif clean_latex.startswith("```"):
        clean_latex = clean_latex[3:]
    if clean_latex.endswith("```"):
        clean_latex = clean_latex[:-3]
    clean_latex = clean_latex.strip()

    if "\\documentclass" not in clean_latex and "\\begin{document}" in current_latex:
        doc_header = current_latex.split("\\begin{document}")[0] + "\\begin{document}\n"
        doc_footer = "\n\\end{document}"
        clean_latex = doc_header + clean_latex + doc_footer

    return {
        "latex": clean_latex,
        "instruction": instruction,
        "stats": stats.to_dict(),
    }

