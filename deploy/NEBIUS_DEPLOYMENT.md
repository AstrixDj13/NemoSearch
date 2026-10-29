# Deploying NemoSearch on Nebius Serverless Endpoints & Jobs

NemoSearch is architected to run natively on **Nebius Serverless AI**:
1. **Nebius Serverless Endpoints**: Hosts the persistent FastAPI + React web application and real-time Server-Sent Events (SSE) multi-agent streaming pipeline (`/api/research`, `/api/followup`, `/api/paper/*`).
2. **Nebius Serverless Jobs**: Runs finite, asynchronous background deep-research workflows and automated LaTeX manuscript packaging (`scripts/nebius_job_worker.py`).

---

## 1. Automated Container Image (`ghcr.io/astrixdj13/nemosearch:latest`)

Every push to `main` triggers [`.github/workflows/nebius-deploy.yml`](../.github/workflows/nebius-deploy.yml), which builds the multi-stage [`Dockerfile`](../Dockerfile) (compiling the React + Vite frontend and packaging the FastAPI backend) and publishes it to:
```
ghcr.io/astrixdj13/nemosearch:latest
```
*(In GitHub → **Packages** → `nemosearch` → **Package settings**, set visibility to **Public** so Nebius Serverless AI can pull it directly).*

To build and push manually if desired:
```bash
docker build -t ghcr.io/astrixdj13/nemosearch:latest .
docker push ghcr.io/astrixdj13/nemosearch:latest
```

---

## 2. Deploying the Live Web App on Nebius Serverless Endpoints

### Option A: Via Nebius Web Console
1. Sign in to the **Nebius AI Cloud Console** and open **Serverless AI → Endpoints**.
2. Click **Create endpoint** and configure:
   - **Name**: `nemosearch-web`
   - **Container image**: `ghcr.io/astrixdj13/nemosearch:latest`
   - **Platform & Preset**: `cpu-d3` → `4vcpu-16gb`
   - **Container port**: `8000`
   - **Public access**: Enable **Public IP**
   - **Environment Variables**:
     - `NEBIUS_API_KEY`: Your Nebius Token Factory API key
     - `NEBIUS_BASE_URL`: `https://api.tokenfactory.nebius.com/v1/`
     - `TAVILY_API_KEY`: Your Tavily API key
     - `OPENALEX_API_KEY`: *(optional)* Your OpenAlex API key
     - `SECRET_KEY`: A 48-byte random secret (`python -c "import secrets; print(secrets.token_urlsafe(48))"`)
     - `ORCID_CLIENT_ID` & `ORCID_CLIENT_SECRET`: From [ORCID Developer Tools](https://orcid.org/developer-tools) (or `https://sandbox.orcid.org`) with callback `https://<your-endpoint-domain>/api/auth/orcid/callback`
3. Click **Create endpoint**. Once the public domain is assigned, add `APP_URL=https://<your-endpoint-domain>` to the endpoint's environment variables.

### Option B: Via Nebius CLI
```bash
bash deploy/nebius_serverless.sh endpoint
```

---

## 3. Running Asynchronous Workflows on Nebius Serverless Jobs

For long-running batch literature reviews and automated LaTeX paper compilation (`main.tex` + `references.bib` + `sections/`), launch a **Nebius Serverless Job** using [`scripts/nebius_job_worker.py`](../scripts/nebius_job_worker.py):

### Via Nebius CLI
```bash
bash deploy/nebius_serverless.sh job "Dense vs. mixture-of-experts models for efficient inference"
```

### Or Directly in Nebius Console (`Serverless AI → Jobs`)
- **Container image**: `ghcr.io/astrixdj13/nemosearch:latest`
- **Platform & Preset**: `cpu-d3` → `4vcpu-16gb`
- **Command**: `python`
- **Arguments**: `-m scripts.nebius_job_worker --question "Dense vs. mixture-of-experts models for efficient inference" --focus academic --depth deep --template neurips`
- **Environment variables**: `NEBIUS_API_KEY`, `TAVILY_API_KEY`

