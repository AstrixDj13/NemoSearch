"""Scholarly-search connectors. Register new providers in `CONNECTORS`; each exposes `name`, `label`
and `async search(query, k, record) -> list[ScholarlyWork]` and raises ConnectorError on failure."""
from __future__ import annotations

from .arxiv import ArxivConnector
from .base import ConnectorError, QueryRecord, ScholarlyWork, utc_now
from .openalex import OpenAlexConnector

CONNECTORS = {"openalex": OpenAlexConnector, "arxiv": ArxivConnector}

__all__ = ["CONNECTORS", "ArxivConnector", "ConnectorError", "OpenAlexConnector", "QueryRecord", "ScholarlyWork", "utc_now"]
