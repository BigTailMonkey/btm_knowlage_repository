"""Per-request trace recorder and usage ledger writer."""
from __future__ import annotations

import hashlib
import time
from datetime import date, datetime, timezone

from .config import settings
from .harness import HarnessResult
from .models import Trace, TraceSpan, UsageLedger, new_id


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TraceRecorder:
    def __init__(self, tenant_id: str, user_id: str, feature: str, question: str = ""):
        self.trace_id = new_id("tr")
        self.tenant_id = tenant_id
        self.user_id = user_id
        self.feature = feature
        self.question = question
        self.started = time.time()
        self.spans: list[TraceSpan] = []
        self.usage: list[UsageLedger] = []
        self.meta: dict = {}
        self.answer = ""
        self.status = "ok"

    def add_span(
        self,
        stage: str,
        params: dict | None = None,
        output: dict | None = None,
        latency_ms: int = 0,
        status: str = "ok",
        input_value: str = "",
    ) -> TraceSpan:
        span = TraceSpan(
            id=new_id("sp"),
            trace_id=self.trace_id,
            stage=stage,
            input_hash=hashlib.sha256(input_value.encode()).hexdigest()[:32]
            if input_value
            else None,
            params=params or {},
            output=output or {},
            latency_ms=latency_ms,
            status=status,
            occurred_at=utcnow(),
        )
        self.spans.append(span)
        return span

    def record_usage(
        self,
        result: HarnessResult,
        feature: str,
        stage: str,
        span_id: str | None = None,
    ) -> UsageLedger:
        price_in, price_out, currency = settings.prices.get(
            result.model, (0.0, 0.0, "CNY")
        )
        amount = (
            result.tokens_in * price_in / 1_000_000
            + result.tokens_out * price_out / 1_000_000
        )
        row = UsageLedger(
            trace_id=self.trace_id,
            span_id=span_id,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            feature=feature,
            stage=stage,
            provider=result.provider,
            model=result.model,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            price_snapshot={
                "input_per_1m": price_in,
                "output_per_1m": price_out,
                "currency": currency,
            },
            amount=round(amount, 8),
            occurred_at=utcnow(),
        )
        self.usage.append(row)
        return row

    def finish(self, db, answer: str = "", status: str = "ok") -> Trace:
        self.answer = answer
        self.status = status
        trace = Trace(
            id=self.trace_id,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            feature=self.feature,
            question=self.question,
            answer=answer,
            status=status,
            latency_ms=int((time.time() - self.started) * 1000),
            meta=self.meta,
            created_at=utcnow(),
        )
        db.add(trace)
        for span in self.spans:
            db.add(span)
        for row in self.usage:
            db.add(row)
        return trace

    @property
    def latency_ms(self) -> int:
        return int((time.time() - self.started) * 1000)


def token_price(provider: str, model: str) -> tuple[float, float, str]:
    return settings.prices.get(model, (0.0, 0.0, "CNY"))


def today() -> date:
    return date.today()
