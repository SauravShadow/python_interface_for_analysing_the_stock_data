"""
routers/analysis.py — Run analysis + save/load/delete saved analyses
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
import uuid
from datetime import datetime

from database import get_db
from models.analysis import Analysis
from schemas.analysis import AnalysisRunRequest, SaveAnalysisRequest, AnalysisSummary
from services.analysis_service import analysis_service

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.post("/run")
async def run_analysis(req: AnalysisRunRequest) -> dict:
    """
    Run analysis on stored stock data.
    Returns chart-ready JSON — no images, Recharts renders it on the frontend.
    """
    result = analysis_service.run(
        mode=req.mode,
        symbols=req.symbols,
        exchange=req.exchange,
        filters=req.filters.model_dump(),
        analysis_types=req.analysis_types,
    )
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/saved")
async def list_saved(db: AsyncSession = Depends(get_db)) -> list[AnalysisSummary]:
    """List all saved analyses (lightweight — no full results)."""
    result = await db.execute(
        select(Analysis).order_by(Analysis.updated_at.desc())
    )
    analyses = result.scalars().all()
    return [
        AnalysisSummary(
            id=a.id,
            name=a.name,
            mode=a.mode,
            symbols=a.symbols,
            created_at=a.created_at.isoformat(),
            updated_at=a.updated_at.isoformat(),
            analysis_types=a.config.get("analysis_types", []),
        )
        for a in analyses
    ]


@router.get("/saved/{analysis_id}")
async def get_saved(analysis_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Load a full saved analysis (config + summary). Re-run to get fresh results."""
    result = await db.execute(
        select(Analysis).where(Analysis.id == analysis_id)
    )
    a = result.scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return a.to_dict()


@router.post("/save")
async def save_analysis(
    req: SaveAnalysisRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """Save or update an analysis config + summary."""
    if req.action == "update" and req.existing_id:
        result = await db.execute(
            select(Analysis).where(Analysis.id == req.existing_id)
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.name = req.name
            existing.config = req.config
            existing.results_summary = req.results_summary
            existing.updated_at = datetime.utcnow()
            await db.flush()
            return {"status": "updated", "id": existing.id}

    # Create new
    a = Analysis(
        id=str(uuid.uuid4()),
        name=req.name,
        mode=req.mode,
        symbols=req.symbols,
        config=req.config,
        results_summary=req.results_summary,
    )
    db.add(a)
    await db.flush()
    return {"status": "saved", "id": a.id}


@router.delete("/saved/{analysis_id}")
async def delete_saved(
    analysis_id: str, db: AsyncSession = Depends(get_db)
) -> dict:
    await db.execute(delete(Analysis).where(Analysis.id == analysis_id))
    return {"status": "deleted", "id": analysis_id}
