"""Authentication and the ACL kernel.

Rules:
* identity comes from a bearer token, never from request parameters;
* ACL is part of every chunk/fact row and is applied *before* ranking;
* missing permission context is rejected, not defaulted to allow.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_db
from .models import User


@dataclass(frozen=True)
class Principal:
    user_id: str
    tenant_id: str
    name: str
    role: str
    groups: tuple[str, ...] = ()
    token: str = ""

    @property
    def principals(self) -> set[str]:
        values = {f"user:{self.user_id}", "tenant:public"}
        values.update(f"group:{g}" for g in self.groups)
        return values


def resolve_token(db: Session, token: str) -> Principal | None:
    if not token:
        return None
    user = db.scalar(select(User).where(User.token == token, User.status == "active"))
    if not user:
        return None
    return Principal(
        user_id=user.id,
        tenant_id=user.tenant_id,
        name=user.name,
        role=user.role,
        groups=tuple(user.groups or []),
        token=user.token,
    )


def get_principal(
    authorization: str | None = Header(default=None),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="缺少 Bearer 令牌")
    token = authorization.split(" ", 1)[1].strip()
    principal = resolve_token(db, token)
    if principal is None:
        raise HTTPException(status_code=401, detail="令牌无效或已停用")
    if x_tenant_id and x_tenant_id != principal.tenant_id:
        raise HTTPException(status_code=403, detail="令牌与租户不匹配")
    return principal


def can_read(principal: Principal, acl_principals: list | None) -> bool:
    if not acl_principals:
        # 默认拒绝：没有显式授权的资源不进入检索。
        return False
    return bool(principal.principals.intersection(set(acl_principals)))


def require_admin(principal: Principal):
    if principal.role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="需要管理员权限")


def require_editor(principal: Principal):
    if principal.role not in {"owner", "admin", "editor"}:
        raise HTTPException(status_code=403, detail="当前主体没有写入权限")


def acl_label(acl_principals: list | None) -> str:
    if not acl_principals:
        return "未授权"
    if "tenant:public" in acl_principals:
        return "全员可见"
    groups = [p.split(":", 1)[1] for p in acl_principals if p.startswith("group:")]
    users = [p.split(":", 1)[1] for p in acl_principals if p.startswith("user:")]
    if groups:
        return "组：" + "、".join(groups)
    if users:
        return "个人：" + "、".join(users)
    return "受限"


def as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value
