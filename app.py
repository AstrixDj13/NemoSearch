"""Hugging Face Spaces (Gradio SDK) entrypoint for NemoSearch.

Hugging Face Spaces' free tier provides 2 vCPU / 16 GB RAM when `sdk: gradio`
is selected. Because Gradio SDK simply executes `python app.py` and routes all
HTTP traffic to port 7860, launching our FastAPI + React application via
Uvicorn on port 7860 serves the exact NemoSearch UI and SSE pipeline for free!
"""
from __future__ import annotations

import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("GRADIO_SERVER_PORT", os.environ.get("PORT", "7860")))
    uvicorn.run("backend.app.main:app", host="0.0.0.0", port=port)

