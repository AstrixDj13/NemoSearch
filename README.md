---
title: NemoSearch
emoji: 🎓
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: "5.0.0"
app_file: app.py
app_port: 7860
pinned: false
---

# 🛩️ NemoSearch: Autonomous Multi-Agent Deep Research on NVIDIA Nemotron

> **Nebius × NVIDIA Global AI Hackathon · Track: Best Apps and Agents**  
> *Targeting Grand Prize ($20,000) and Best Use of Tavily ($3,000)*
>
> An enterprise-grade, Perplexity-style deep research engine powered by a specialized 3-tier **NVIDIA Nemotron 3** ensemble hosted on **Nebius Token Factory**, orchestrated with **Tavily AI Search**.

---

## ⚡ Highlights & Perplexity-Grade Capabilities

1. **Focus Modes**: Target your research across 4 dedicated domains:
   - 🌐 **All Web**: Broad multi-angle general intelligence.
   - 🎓 **Academic & ArXiv**: Curated for peer-reviewed preprints, arXiv, PubMed, and Nature.
   - 📈 **Finance & SEC**: Tailored for SEC filings, earnings transcripts, Bloomberg, and market forecasts.
   - 📰 **Recent News**: Real-time breaking developments within the last 7 days.
2. **Hover-to-Verify Citations**: Hovering over any citation tag (`[1]`, `[2]`) renders an instant verification card displaying the **source domain, relevance score, and verbatim quote** directly extracted by the Reader agent.
3. **Interactive Multi-Turn Thread Memory**: Have a continuous conversation with your research brief. Ask follow-up questions; Nemotron Nano assesses if new web retrieval is needed, and Nemotron Ultra reasons over the combined context.
4. **Executive Slide Deck Generator**: One-click synthesis of an executive 5-slide presentation outline with key takeaways, generated live from the research brief.
5. **Executive PDF Export**: Styled print-ready executive briefing sheets.
6. **"Right Model for the Right Task" Telemetry**: Live dashboard demonstrating token and latency efficiency across the 3 specialized Nemotron tiers.

---

## 🧠 Multi-Agent Architecture

```mermaid
flowchart TD
  U[User Question & Focus Mode] --> P["Planner · Nemotron-3-Nano (30B)"]
  P -->|Decomposed Sub-Queries| S["Scout · Tavily AI Search"]
  S -->|Retrieved Web Content| R["Readers ×N · Nemotron-3-Super (120B) (Parallel)"]
  R -->|Extracted Facts + Verbatim Quotes| C["Critic · Nemotron-3-Nano (30B)"]
  C -->|Deep Mode: Gap Analysis & Follow-up Queries| S
  C --> W["Lead Analyst · Nemotron-3-Ultra (550B)"]
  W -->|SSE Streaming with Detailed Reasoning| UI["Live Workspace (Graph, Report, Citations, Metrics)"]
  UI --> F["Interactive Q&A · Continuous Research Thread"]
  UI --> D["Slide Deck & PDF Synthesis"]
```

### Specialized Model Routing:
| Role | Model on Nebius Token Factory | Core Responsibility |
|---|---|---|
| 🧭 **Planner** | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | High-speed query decomposition & search strategy |
| 🛰️ **Scout** | `Tavily Search API` | Real-time web retrieval with domain filtering & news topics |
| 📖 **Readers ×N** | `nvidia/nemotron-3-super-120b-a12b` | Parallel evidence parsing & verbatim quote extraction |
| 🧪 **Critic** | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Coverage auditing and recursive gap analysis |
| ✍️ **Writer** | `nvidia/Nemotron-3-Ultra-550b-a55b` | Complex reasoning (`detailed thinking on`) and cited Markdown briefing |

---

## 🚀 Quick Start

### 1. Setup Virtual Environment
```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
```

### 2. Configure Environment Keys
Create your `.env` file (see `.env.example`):
```env
# Nebius Token Factory (get key at https://tokenfactory.nebius.com)
NEBIUS_API_KEY=your_nebius_api_key
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1/

# Tavily AI Search (get key at https://tavily.com)
TAVILY_API_KEY=your_tavily_api_key

# NVIDIA Nemotron 3 Models
MODEL_NANO=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B
MODEL_SUPER=nvidia/nemotron-3-super-120b-a12b
MODEL_ULTRA=nvidia/Nemotron-3-Ultra-550b-a55b
```

### 3. Launch Application
```powershell
cd backend
..\.venv\Scripts\python -m uvicorn app.main:app --port 8000
```
Open **[http://localhost:8000](http://localhost:8000)** in your browser.

Signing in uses ORCID. For local development without ORCID credentials, add `AUTH_DEV_LOGIN=1` to `.env`: the sign-in page then offers a development sign-in (refused anywhere but localhost).

---

## 🔐 Accounts, Library and Network

- **Accounts**: sign in with ORCID only, so every account has a verified ORCID iD. Sessions are HttpOnly cookies, stored hashed.
- **Library** (private): research, saved sources, files and exports belong to your account. Share a project with collaborators by ORCID iD; they can read it and add to it, and only you can rename, archive, delete or re-share it.
- **Network** (public-facing): publish a PDF or one of your reports. Works start **Private**; **Request access** shows the metadata and shares the file only with people you approve; **Open** lets anyone read it. Making a work shareable requires a license and a rights confirmation.
- **Ownership record**: every upload is SHA-256 fingerprinted and appended to a hash-chained, append-only log (immutable in PostgreSQL via trigger). It is evidence of who uploaded which bytes and when, not a certificate of authorship.
- **Requests**: ask to read a work, or propose a collaboration; accepting a collaboration opens a shared project. Blocking, abuse reports, admin takedowns, per-account rate limits, and claiming papers published elsewhere (when OpenAlex lists your ORCID iD as an author) are built in. No feeds, likes or follower counts.
- **Permissions** are enforced on the server for every request, including downloads (short-lived signed links). Private works never appear in search, profiles or listings.

### Deploying on Nebius Serverless AI

NemoSearch ships with first-class deployment support for both **Nebius Serverless Endpoints** (real-time web app + SSE streaming pipeline) and **Nebius Serverless Jobs** (asynchronous background deep-research & LaTeX manuscript generation):

- **Container Image ([Dockerfile](Dockerfile))**: Multi-stage build compiling the React/Vite Paper Studio UI (`frontend_src/`) and running the FastAPI + Uvicorn backend (`backend.app.main:app`) on port `8000`.
- **Automated GHCR CI/CD ([.github/workflows/nebius-deploy.yml](.github/workflows/nebius-deploy.yml))**: Automatically builds and pushes `ghcr.io/astrixdj13/nemosearch:latest` whenever `main` is updated.
- **Nebius Serverless Endpoints ([deploy/nebius_serverless.sh](deploy/nebius_serverless.sh))**: Deploys the persistent web application and live SSE agent streaming via `nebius ai endpoint create`:
  ```bash
  ./deploy/nebius_serverless.sh endpoint
  ```
- **Nebius Serverless Jobs ([scripts/nebius_job_worker.py](scripts/nebius_job_worker.py))**: Runs headless batch research + Overleaf `.zip` package generation via `nebius ai job create`:
  ```bash
  ./deploy/nebius_serverless.sh job "Dense vs. Mixture-of-Experts models for efficient inference" neurips
  ```
- **Full Step-by-Step Guide**: See **[deploy/NEBIUS_DEPLOYMENT.md](deploy/NEBIUS_DEPLOYMENT.md)** for Web Console and CLI instructions.

#### Production Environment Hardening
When `APP_ENV=production` is set, the server enforces strict startup checks and refuses to start until it has an `https://` `APP_URL`, a strong `SECRET_KEY`, a PostgreSQL `DATABASE_URL`, S3-compatible storage (`STORAGE_BACKEND=s3`), and ORCID credentials. See `.env.example`. Tables are created on first start; later schema changes need a migration.

Data from the old single-user database can be copied into an account with `python scripts/import_legacy_db.py <your ORCID iD>`.

### Tests
```powershell
.\.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
.\.venv\Scripts\python -m pytest backend\tests                 # SQLite
$env:TEST_DB="postgres"; .\.venv\Scripts\python -m pytest backend\tests   # throwaway local PostgreSQL
```

---

## 📋 Evaluation Criteria Mapping

- **Technical Execution**: Full async streaming architecture via Server-Sent Events (SSE), parallel Reader agents governed by an async semaphore, robust JSON extraction from reasoning models, and seamless chat-template kwargs handling for `enable_thinking`.
- **Use of Nemotron**: True ensemble leveraging three Nemotron-3 model scales (Nano 30B, Super 120B, Ultra 550B), demonstrating why multi-tier routing beats monolithic LLM calls in both speed and cost.
- **Use of Tavily**: Advanced search depth with domain filtering for Academic and Finance focus modes, plus real-time news extraction.
- **Impact & UX**: Closes the gap between automated research and human decision-making with verifiable citation hovercards, slide outlines, and continuous conversational follow-ups.
