"""Vercel entry point for the planning API.

Vercel builds every file in api/ into a function; this one loads the
FastAPI app from backend/ unchanged. vercel.json rewrites /api/* here, and
FastAPI still sees the original path, so the routes in backend/main.py
(/api/view-plan, /api/curated-buildings) match as they do locally.
"""

import sys
from pathlib import Path

# backend/ uses flat imports (`import planning`), as it does under uvicorn.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from main import app  # noqa: E402

__all__ = ["app"]
