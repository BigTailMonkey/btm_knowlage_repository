"""Document ingestion and library endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal, get_db
from .ingestion import list_ingest_jobs, submit_ingest, tombstone_document
from .learning import extract_facts_for_document
from .models import Chunk, Document, DocumentVersion, Entity, Fact, FactEvidence, User
from .security import Principal, can_read, get_principal, require_editor
from .serializers import chunk_dict, document_dict, entity_dict, fact_dict

router = APIRouter(prefix="/documents", tags=["documents"])


class TextIn(BaseModel):
    text: str = Field(min_length=1)
    title: str | None = None
    acl: list[str] | None = None


class UrlIn(BaseModel):
    url: str
    title: str | None = None
    acl: list[str] | None = None


def _parse_acl(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    return [item.strip() for item in raw.split(",") if item.strip()]


def _get_visible_doc(db: Session, principal: Principal, doc_id: str) -> Document:
    document = db.get(Document, doc_id)
    if (
        not document
        or document.tenant_id != principal.tenant_id
        or not can_read(principal, document.acl_principals)
        or document.status == "tombstoned"
    ):
        raise HTTPException(status_code=404, detail="文档不存在或无权访问")
    return document


@router.post("/upload")
def upload_document(
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    acl: str | None = Form(default=None),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_editor(principal)
    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件超过 30MB")
    return submit_ingest(
        db,
        principal,
        "file",
        title=title,
        filename=file.filename or "document.txt",
        data=data,
        acl=_parse_acl(acl),
    )


@router.post("/text")
def add_text_document(
    payload: TextIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_editor(principal)
    return submit_ingest(
        db, principal, "text", title=payload.title, text=payload.text, acl=payload.acl
    )


@router.post("/url")
def add_url_document(
    payload: UrlIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_editor(principal)
    if not payload.url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="仅支持 http/https URL")
    return submit_ingest(
        db, principal, "url", title=payload.title, url=payload.url, acl=payload.acl
    )


@router.get("/jobs")
def ingest_jobs(
    active: bool = Query(default=False),
    principal: Principal = Depends(get_principal),
):
    """当前用户的异步入库作业列表，供前端轮询阶段进度。"""
    return {"items": list_ingest_jobs(principal, active_only=active)}


@router.get("/acl-options")
def acl_options(
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """可授予的权限组：当前租户内用户所属的全部组名。"""
    groups: set[str] = set()
    for user in db.scalars(select(User).where(User.tenant_id == principal.tenant_id)):
        groups.update(user.groups or [])
    return {"groups": sorted(groups)}


@router.get("")
def list_documents(
    q: str | None = None,
    source_type: str | None = None,
    status: str = Query(default="active"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    statement = select(Document).where(Document.tenant_id == principal.tenant_id)
    if status:
        statement = statement.where(Document.status == status)
    if source_type:
        statement = statement.where(Document.source_type == source_type)
    if q:
        statement = statement.where(Document.title.contains(q))
    documents = db.execute(
        statement.order_by(Document.updated_at.desc()).limit(limit).offset(offset)
    ).scalars().all()
    visible = [doc for doc in documents if can_read(principal, doc.acl_principals)]
    return {
        "total": len(visible),
        "limit": limit,
        "offset": offset,
        "items": [document_dict(db, doc) for doc in visible],
    }


@router.get("/{doc_id}")
def document_detail(
    doc_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    document = _get_visible_doc(db, principal, doc_id)
    versions = db.execute(
        select(DocumentVersion)
        .where(DocumentVersion.doc_id == document.id)
        .order_by(DocumentVersion.version.desc())
    ).scalars().all()
    chunk_rows = db.execute(
        select(Chunk)
        .where(
            Chunk.doc_id == document.id,
            Chunk.is_parent.is_(False),
            Chunk.version_id.in_(
                select(DocumentVersion.id).where(
                    DocumentVersion.doc_id == document.id,
                    DocumentVersion.version == document.current_version,
                )
            ),
        )
        .order_by(Chunk.seq)
        .limit(60)
    ).scalars().all()
    evidence_rows = db.execute(
        select(FactEvidence).where(FactEvidence.doc_id == document.id)
    ).scalars().all()
    fact_ids = {row.fact_id for row in evidence_rows}
    facts = []
    entity_ids: set[str] = set()
    for fact_id in fact_ids:
        fact = db.get(Fact, fact_id)
        if not fact or not can_read(principal, fact.acl_principals):
            continue
        facts.append(fact_dict(db, fact))
        entity_ids.add(fact.subject_id)
        if fact.object_id:
            entity_ids.add(fact.object_id)
    entities = [
        entity_dict(entity)
        for entity in (db.get(Entity, entity_id) for entity_id in entity_ids)
        if entity and can_read(principal, entity.acl_principals)
    ]
    return {
        "document": document_dict(db, document),
        "versions": [
            {
                "id": version.id,
                "version": version.version,
                "parser": version.parser,
                "hash": version.hash[:16],
                "chars": len(version.text),
                "created_at": version.created_at.isoformat() if version.created_at else None,
            }
            for version in versions
        ],
        "chunks": [chunk_dict(chunk, document) for chunk in chunk_rows],
        "facts": facts,
        "entities": entities,
    }


@router.post("/{doc_id}/reprocess")
def reprocess_document(
    doc_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_editor(principal)
    document = _get_visible_doc(db, principal, doc_id)

    def run():
        with SessionLocal() as background_db:
            try:
                extract_facts_for_document(background_db, principal, document.id)
            except Exception:  # noqa: BLE001
                background_db.rollback()

    import threading

    threading.Thread(target=run, daemon=True, name=f"reprocess-{doc_id}").start()
    return {"document_id": doc_id, "status": "queued", "message": "已排入事实抽取队列"}


@router.delete("/{doc_id}")
def delete_document(
    doc_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_editor(principal)
    document = _get_visible_doc(db, principal, doc_id)
    return tombstone_document(db, principal, document.id)
