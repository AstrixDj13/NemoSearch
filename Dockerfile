# Stage 1: Build the React + Vite frontend bundle
FROM node:20-slim AS frontend-builder
WORKDIR /build/frontend_src
COPY frontend_src/package.json frontend_src/package-lock.json* ./
RUN npm ci
COPY frontend_src/ ./
RUN npm run build

# Stage 2: Production Python FastAPI runtime for Nebius Serverless Endpoints & Jobs
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# Install backend dependencies
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r backend/requirements.txt

# Copy backend application, scripts, and compiled frontend bundle
COPY backend ./backend
COPY scripts ./scripts
COPY --from=frontend-builder /build/frontend ./frontend

# Create local data directory for SQLite / local blob fallback
RUN mkdir -p /app/data

EXPOSE 8000

# Default entrypoint serves the web app & SSE API for Nebius Serverless Endpoints;
# Nebius Serverless Jobs can override --container-command to run scripts/nebius_job_worker.py
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

