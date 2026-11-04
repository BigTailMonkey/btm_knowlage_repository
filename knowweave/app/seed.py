"""First-run bootstrap: default tenant, owner account, budget and model prices.

Only scaffolding lives here. Documents, facts, reviews and evaluation cases are
content supplied by the user, never seeded automatically.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import Budget, ModelPrice, Tenant, User


def seed_if_empty(db: Session):
    if db.scalar(select(Tenant).limit(1)):
        return
    tenant = Tenant(id=settings.default_tenant_id, name="知织工作区")
    db.add(tenant)
    db.add(
        User(
            id="u_owner",
            tenant_id=tenant.id,
            name="何道伟",
            email="owner@knowweave.local",
            role="owner",
            groups=["everyone", "finance", "exec", "engineering"],
            token="owner-token",
        )
    )
    db.add(
        Budget(
            tenant_id=tenant.id,
            scope="tenant",
            period="month",
            limit_amount=100.0,
            used_amount=0.0,
            alert_at=0.8,
        )
    )
    for model, (price_in, price_out, currency) in settings.prices.items():
        db.add(
            ModelPrice(
                provider=settings.provider if model != "bge-m3-local-hash" else "local",
                model=model,
                input_per_1m=price_in,
                output_per_1m=price_out,
                currency=currency,
                effective_from=date(2026, 1, 1),
            )
        )
    db.commit()
