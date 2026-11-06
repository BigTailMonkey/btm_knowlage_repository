"""Operations console: traces, costs, budgets, eval and harness health."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .harness import harness
from .models import (
    Budget,
    Chunk,
    Document,
    DocumentVersion,
    Entity,
    EvalCase,
    EvalRun,
    Fact,
    Gap,
    ModelPrice,
    ReplayRun,
    ReviewItem,
    Trace,
    TraceSpan,
    UsageLedger,
    new_id,
)
from .retrieval import retrieve
from .security import Principal, get_principal, require_admin
from .timeutil import today_local, to_local
from .tracing import TraceRecorder, token_price

router = APIRouter(tags=["ops"])


class PriceIn(BaseModel):
    provider: str
    model: str
    input_per_1m: float = 0
    output_per_1m: float = 0
    currency: str = "CNY"
    effective_from: date | None = None


class ReplayIn(BaseModel):
    target_stage: str = "retrieve"
    top_k: int = 8
    as_of: str | None = None


@router.get("/stats")
def stats(
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    tenant = principal.tenant_id
    doc_count = db.scalar(
        select(func.count(Document.id)).where(
            Document.tenant_id == tenant, Document.status == "active"
        )
    )
    chunk_count = db.scalar(
        select(func.count(Chunk.id)).where(
            Chunk.tenant_id == tenant, Chunk.is_parent.is_(False)
        )
    )
    entity_count = db.scalar(
        select(func.count(Entity.id)).where(
            Entity.tenant_id == tenant, Entity.status == "active"
        )
    )
    active_facts = db.scalar(
        select(func.count(Fact.id)).where(Fact.tenant_id == tenant, Fact.status == "active")
    )
    disputed_facts = db.scalar(
        select(func.count(Fact.id)).where(Fact.tenant_id == tenant, Fact.status == "disputed")
    )
    open_reviews = db.scalar(
        select(func.count(ReviewItem.id)).where(
            ReviewItem.tenant_id == tenant, ReviewItem.status == "open"
        )
    )
    open_gaps = db.scalar(
        select(func.count(Gap.id)).where(Gap.tenant_id == tenant, Gap.status == "open")
    )
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    ask_traces = db.execute(
        select(Trace).where(
            Trace.tenant_id == tenant,
            Trace.feature == "ask",
            Trace.created_at >= week_ago,
        )
    ).scalars().all()
    refused = sum(1 for trace in ask_traces if trace.status == "refused")
    spend = db.scalar(
        select(func.coalesce(func.sum(UsageLedger.amount), 0.0)).where(
            UsageLedger.tenant_id == tenant
        )
    )
    budget = db.scalar(
        select(Budget).where(Budget.tenant_id == tenant, Budget.scope == "tenant")
    )
    recent_docs = db.execute(
        select(Document)
        .where(Document.tenant_id == tenant, Document.status == "active")
        .order_by(Document.updated_at.desc())
        .limit(5)
    ).scalars().all()
    recent_traces = db.execute(
        select(Trace)
        .where(Trace.tenant_id == tenant)
        .order_by(Trace.created_at.desc())
        .limit(6)
    ).scalars().all()
    return {
        "documents": doc_count or 0,
        "chunks": chunk_count or 0,
        "entities": entity_count or 0,
        "facts_active": active_facts or 0,
        "facts_disputed": disputed_facts or 0,
        "reviews_open": open_reviews or 0,
        "gaps_open": open_gaps or 0,
        "asks_7d": len(ask_traces),
        "refusal_rate_7d": round(refused / len(ask_traces), 3) if ask_traces else 0.0,
        "spend_cny": round(float(spend or 0), 4),
        "budget": {
            "limit": budget.limit_amount if budget else 0,
            "used": round(float(spend or 0), 4),
            "alert_at": budget.alert_at if budget else 0.8,
        },
        "recent_documents": [
            {
                "id": document.id,
                "title": document.title,
                "source_type": document.source_type,
                "updated_at": document.updated_at.isoformat()
                if document.updated_at
                else None,
            }
            for document in recent_docs
        ],
        "recent_traces": [
            {
                "id": trace.id,
                "feature": trace.feature,
                "question": trace.question[:80],
                "status": trace.status,
                "latency_ms": trace.latency_ms,
                "created_at": trace.created_at.isoformat()
                if trace.created_at
                else None,
            }
            for trace in recent_traces
        ],
    }


@router.get("/traces")
def list_traces(
    feature: str | None = None,
    status: str | None = None,
    limit: int = Query(default=40, ge=1, le=200),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    statement = select(Trace).where(Trace.tenant_id == principal.tenant_id)
    if feature:
        statement = statement.where(Trace.feature == feature)
    if status:
        statement = statement.where(Trace.status == status)
    traces = db.execute(
        statement.order_by(Trace.created_at.desc()).limit(limit)
    ).scalars().all()
    return {
        "items": [
            {
                "id": trace.id,
                "feature": trace.feature,
                "question": trace.question[:120],
                "answer": trace.answer[:180],
                "status": trace.status,
                "latency_ms": trace.latency_ms,
                "user_id": trace.user_id,
                "meta": trace.meta,
                "created_at": trace.created_at.isoformat() if trace.created_at else None,
            }
            for trace in traces
        ]
    }


@router.get("/traces/{trace_id}")
def trace_detail(
    trace_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    trace = db.get(Trace, trace_id)
    if not trace or trace.tenant_id != principal.tenant_id:
        raise HTTPException(status_code=404, detail="轨迹不存在")
    spans = db.execute(
        select(TraceSpan)
        .where(TraceSpan.trace_id == trace_id)
        .order_by(TraceSpan.occurred_at)
    ).scalars().all()
    usage = db.execute(
        select(UsageLedger).where(UsageLedger.trace_id == trace_id)
    ).scalars().all()
    replays = db.execute(
        select(ReplayRun).where(ReplayRun.trace_id == trace_id)
    ).scalars().all()
    return {
        "trace": {
            "id": trace.id,
            "feature": trace.feature,
            "question": trace.question,
            "answer": trace.answer,
            "status": trace.status,
            "latency_ms": trace.latency_ms,
            "meta": trace.meta,
            "created_at": trace.created_at.isoformat() if trace.created_at else None,
        },
        "spans": [
            {
                "id": span.id,
                "stage": span.stage,
                "params": span.params,
                "output": span.output,
                "latency_ms": span.latency_ms,
                "status": span.status,
                "occurred_at": span.occurred_at.isoformat()
                if span.occurred_at
                else None,
            }
            for span in spans
        ],
        "usage": [
            {
                "model": row.model,
                "provider": row.provider,
                "tokens_in": row.tokens_in,
                "tokens_out": row.tokens_out,
                "amount": row.amount,
                "price": row.price_snapshot,
            }
            for row in usage
        ],
        "replays": [
            {
                "id": replay.id,
                "target_stage": replay.target_stage,
                "overrides": replay.overrides,
                "diff": replay.diff,
                "created_at": replay.created_at.isoformat()
                if replay.created_at
                else None,
            }
            for replay in replays
        ],
    }


@router.post("/traces/{trace_id}/replay")
def replay_trace(
    trace_id: str,
    payload: ReplayIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    trace = db.get(Trace, trace_id)
    if not trace or trace.tenant_id != principal.tenant_id:
        raise HTTPException(status_code=404, detail="轨迹不存在")
    if payload.target_stage not in {"retrieve"}:
        raise HTTPException(status_code=400, detail="当前仅支持检索阶段回放")
    previous = (trace.meta or {}).get("evidence_ids", [])
    result = retrieve(
        db,
        principal,
        trace.question,
        top_k=payload.top_k,
        as_of=payload.as_of,
        mode=(trace.meta or {}).get("mode", "quick"),
    )
    current = [hit.chunk.id for hit in result.hits]
    diff = {
        "previous": previous,
        "current": current,
        "added": [chunk_id for chunk_id in current if chunk_id not in previous],
        "removed": [chunk_id for chunk_id in previous if chunk_id not in current],
        "top_score": result.stats.get("top_score"),
    }
    replay = ReplayRun(
        trace_id=trace.id,
        tenant_id=principal.tenant_id,
        target_stage="retrieve",
        overrides=payload.model_dump(),
        diff=diff,
        status="done",
    )
    db.add(replay)
    db.commit()
    return {
        "replay_id": replay.id,
        "diff": diff,
        "hits": [hit.to_dict() for hit in result.hits],
        "stats": result.stats,
    }


@router.get("/costs/summary")
def costs_summary(
    days: int = Query(default=30, ge=1, le=365),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.execute(
        select(UsageLedger).where(
            UsageLedger.tenant_id == principal.tenant_id,
            UsageLedger.occurred_at >= since,
        )
    ).scalars().all()
    by_feature: dict[str, dict] = defaultdict(lambda: {"amount": 0.0, "calls": 0, "tokens": 0})
    by_day: dict[str, float] = defaultdict(float)
    by_model: dict[str, dict] = defaultdict(lambda: {"amount": 0.0, "calls": 0})
    for row in rows:
        feature = by_feature[row.feature]
        feature["amount"] += row.amount
        feature["calls"] += 1
        feature["tokens"] += row.tokens_in + row.tokens_out
        by_day[to_local(row.occurred_at).date().isoformat()] += row.amount
        model = by_model[f"{row.provider}/{row.model}"]
        model["amount"] += row.amount
        model["calls"] += 1
    return {
        "days": days,
        "total_amount": round(sum(row.amount for row in rows), 6),
        "total_tokens": sum(row.tokens_in + row.tokens_out for row in rows),
        "by_feature": {
            key: {"amount": round(value["amount"], 6), "calls": value["calls"], "tokens": value["tokens"]}
            for key, value in by_feature.items()
        },
        "by_day": [
            {"date": key, "amount": round(value, 6)}
            for key, value in sorted(by_day.items())
        ],
        "by_model": {
            key: {"amount": round(value["amount"], 6), "calls": value["calls"]}
            for key, value in by_model.items()
        },
    }


@router.get("/prices")
def list_prices(
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    prices = db.execute(select(ModelPrice).order_by(ModelPrice.effective_from.desc())).scalars().all()
    return {
        "items": [
            {
                "id": price.id,
                "provider": price.provider,
                "model": price.model,
                "input_per_1m": price.input_per_1m,
                "output_per_1m": price.output_per_1m,
                "currency": price.currency,
                "effective_from": str(price.effective_from),
                "effective_to": str(price.effective_to) if price.effective_to else None,
            }
            for price in prices
        ],
        "current_runtime": {
            "model": settings.model,
            "provider": settings.provider,
            "price": token_price(settings.provider, settings.model),
        },
    }


@router.post("/prices")
def add_price(
    payload: PriceIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_admin(principal)
    price = ModelPrice(
        provider=payload.provider,
        model=payload.model,
        input_per_1m=payload.input_per_1m,
        output_per_1m=payload.output_per_1m,
        currency=payload.currency,
        effective_from=payload.effective_from or today_local(),
    )
    db.add(price)
    db.commit()
    return {"id": price.id, "status": "created"}


@router.get("/harness/health")
def harness_health(
    principal: Principal = Depends(get_principal),
):
    return harness.health()


@router.get("/evals/cases")
def eval_cases(
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    cases = db.execute(
        select(EvalCase).where(EvalCase.tenant_id == principal.tenant_id)
    ).scalars().all()
    return {
        "total": len(cases),
        "items": [
            {
                "id": case.id,
                "question": case.question,
                "expected_docs": case.expected_docs,
                "expected_keywords": case.expected_keywords,
                "should_refuse": case.should_refuse,
            }
            for case in cases
        ],
    }


@router.post("/evals/run")
def run_evals(
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_admin(principal)
    cases = db.execute(
        select(EvalCase).where(EvalCase.tenant_id == principal.tenant_id)
    ).scalars().all()
    doc_hits = 0
    keyword_hits = 0
    refusals = 0
    results = []
    for case in cases:
        result = retrieve(db, principal, case.question, top_k=8)
        doc_titles = [hit.document.title for hit in result.hits]
        matched_docs = [
            expected
            for expected in (case.expected_docs or [])
            if any(expected in title for title in doc_titles)
        ]
        matched_keywords = [
            keyword
            for keyword in (case.expected_keywords or [])
            if any(keyword in hit.chunk.text for hit in result.hits)
        ]
        success_doc = len(matched_docs) == len(case.expected_docs or []) or (
            not case.expected_docs and not case.should_refuse
        )
        success_keyword = len(matched_keywords) == len(case.expected_keywords or []) or (
            not case.expected_keywords
        )
        refused = result.stats.get("top_score", 0) < settings.rerank_threshold
        success_refusal = (refused == case.should_refuse)
        doc_hits += 1 if success_doc else 0
        keyword_hits += 1 if success_keyword else 0
        refusals += 1 if success_refusal else 0
        results.append(
            {
                "question": case.question,
                "expected_docs": case.expected_docs,
                "matched_docs": matched_docs,
                "matched_keywords": matched_keywords,
                "top_score": result.stats.get("top_score", 0),
                "refused": refused,
                "pass": success_doc and success_keyword and success_refusal,
            }
        )
    total = max(1, len(cases))
    metrics = {
        "cases": len(cases),
        "doc_recall": round(doc_hits / total, 3),
        "keyword_recall": round(keyword_hits / total, 3),
        "refusal_accuracy": round(refusals / total, 3),
        "pass_rate": round(
            sum(1 for result in results if result["pass"]) / total, 3
        ),
    }
    run = EvalRun(
        tenant_id=principal.tenant_id,
        metrics=metrics,
        model_version=settings.model,
    )
    db.add(run)
    db.commit()
    return {"run_id": run.id, "metrics": metrics, "results": results}
