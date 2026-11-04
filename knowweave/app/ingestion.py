"""Document ingestion pipeline: hash dedupe → parse → blocks → chunks → index."""
from __future__ import annotations

import hashlib
import io
import threading
import time
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .chunking import chunk_blocks
from .config import settings
from .db import SessionLocal
from .embeddings import embedder
from .models import (
    Block,
    Chunk,
    Document,
    DocumentVersion,
    Fact,
    FactEvidence,
    Job,
    new_id,
)
from .parsing import ParsedDocument, parse_bytes, parse_html, parse_text_content
from .security import Principal
from .tracing import TraceRecorder


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _resolve_acl(acl: list[str] | None) -> list[str]:
    cleaned = [value.strip() for value in (acl or []) if value and value.strip()]
    return cleaned or ["tenant:public"]


def find_duplicate(db: Session, tenant_id: str, content_hash: str) -> Document | None:
    return db.scalar(
        select(Document).where(
            Document.tenant_id == tenant_id,
            Document.content_hash == content_hash,
            Document.status == "active",
        )
    )


def _find_existing(db: Session, tenant_id: str, uri: str | None) -> Document | None:
    if not uri:
        return None
    return db.scalar(
        select(Document).where(
            Document.tenant_id == tenant_id,
            Document.uri == uri,
            Document.status == "active",
        ).order_by(Document.updated_at.desc())
    )


def ingest_parsed(
    db: Session,
    principal: Principal,
    parsed: ParsedDocument,
    source_type: str,
    uri: str | None = None,
    acl: list[str] | None = None,
    background: bool = True,
) -> dict:
    started = time.time()
    full_text = "\n\n".join(block.text for block in parsed.blocks)
    content_hash = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
    duplicate = find_duplicate(db, principal.tenant_id, content_hash)
    if duplicate:
        return {
            "document_id": duplicate.id,
            "duplicate": True,
            "version": duplicate.current_version,
            "chunks": 0,
            "quality": duplicate.quality_score,
            "message": "内容未变化，已跳过重复入库",
        }

    acl = _resolve_acl(acl)
    existing = _find_existing(db, principal.tenant_id, uri)
    recorder = TraceRecorder(principal.tenant_id, principal.user_id, "ingest", parsed.title)
    if existing:
        document = existing
        version_number = document.current_version + 1
        document.acl_version += 1
    else:
        document = Document(
            id=new_id("doc"),
            tenant_id=principal.tenant_id,
            title=parsed.title,
            source_type=source_type,
            uri=uri,
            content_hash=content_hash,
            acl_principals=acl,
            acl_version=1,
            status="active",
            current_version=1,
            quality_score=parsed.quality,
            enrichment_status="pending",
            summary=full_text[:240],
        )
        db.add(document)
        db.flush()
        version_number = 1

    document.content_hash = content_hash
    document.title = parsed.title or document.title
    document.source_type = source_type
    document.quality_score = parsed.quality
    document.current_version = version_number
    document.enrichment_status = "pending"
    document.summary = full_text[:240]
    document.acl_principals = acl
    document.updated_at = datetime.now(timezone.utc)

    version = DocumentVersion(
        id=new_id("ver"),
        doc_id=document.id,
        tenant_id=principal.tenant_id,
        version=version_number,
        hash=content_hash,
        parser=parsed.parser,
        text=full_text,
        meta=parsed.meta,
    )
    db.add(version)
    db.flush()

    for block in parsed.blocks:
        db.add(
            Block(
                version_id=version.id,
                doc_id=document.id,
                type=block.type,
                page=block.page,
                bbox=block.bbox,
                order_index=block.order,
                heading_path=block.heading_path,
                text=block.text,
            )
        )

    chunks = chunk_blocks(parsed.blocks)
    embedding_inputs: list[tuple[str, str]] = []
    for item in chunks:
        if item["is_parent"]:
            continue
        embedding_inputs.append(
            (
                item["id"],
                f"标题：{document.title}｜章节：{' / '.join(item['heading_path'])}\n{item['text']}",
            )
        )
    embeddings = dict(
        zip(
            [chunk_id for chunk_id, _ in embedding_inputs],
            embedder.embed_many([text for _, text in embedding_inputs]),
        )
    )
    for item in chunks:
        item_text = item["text"]
        embedding = embeddings.get(item["id"])
        if embedding is None:
            dense, sparse, model, dim = [], {}, "", 0
        else:
            dense, sparse, model, dim = (
                embedding.dense,
                embedding.sparse,
                embedding.model,
                embedding.dim,
            )
        db.add(
            Chunk(
                id=item["id"],
                version_id=version.id,
                doc_id=document.id,
                tenant_id=principal.tenant_id,
                seq=item["seq"],
                heading_path=item["heading_path"],
                page=item["page"],
                bbox=item["bbox"],
                block_type=item["block_type"],
                text=item_text,
                token_count=item["token_count"],
                parent_id=item["parent_id"],
                is_parent=item["is_parent"],
                acl_principals=acl,
                acl_version=document.acl_version,
                dense=dense,
                sparse=sparse,
                embedding_model=model,
                embedding_dim=dim,
                weight=1.0,
            )
        )

    job = Job(
        id=new_id("job"),
        tenant_id=principal.tenant_id,
        type="ingest",
        status="done",
        input_hash=content_hash,
        payload={"doc_id": document.id, "version": version_number, "parser": parsed.parser},
    )
    db.add(job)
    recorder.add_span(
        "ingest.parse",
        params={"parser": parsed.parser, "source_type": source_type},
        output={"blocks": len(parsed.blocks), "quality": parsed.quality},
    )
    recorder.add_span(
        "ingest.chunk",
        params={"max_chars": 460},
        output={"chunks": len([c for c in chunks if not c["is_parent"]])},
        input_value=full_text,
    )
    recorder.finish(
        db,
        answer=f"{document.title} · v{version_number}",
        status="ok",
    )
    db.commit()

    if background:
        _schedule_enrichment(document.id, principal)

    return {
        "document_id": document.id,
        "duplicate": False,
        "version": version_number,
        "chunks": len([c for c in chunks if not c["is_parent"]]),
        "quality": parsed.quality,
        "parser": parsed.parser,
        "job_id": job.id,
        "trace_id": recorder.trace_id,
        "latency_ms": int((time.time() - started) * 1000),
        "message": "文档已入库，正在后台抽取事实",
    }


def _schedule_enrichment(doc_id: str, principal: Principal):
    def run():
        from .learning import extract_facts_for_document

        with SessionLocal() as db:
            try:
                extract_facts_for_document(db, principal, doc_id)
            except Exception:  # noqa: BLE001 - background boundary
                db.rollback()

    thread = threading.Thread(target=run, name=f"enrich-{doc_id}", daemon=True)
    thread.start()


def ingest_upload(
    db: Session,
    principal: Principal,
    filename: str,
    data: bytes,
    title: str | None = None,
    acl: list[str] | None = None,
    background: bool = True,
) -> dict:
    parsed = parse_bytes(filename, data, title=title)
    source_type = filename.rsplit(".", 1)[-1].lower() if "." in filename else "file"
    return ingest_parsed(
        db,
        principal,
        parsed,
        source_type=source_type,
        uri=f"upload:{filename}:{sha256_bytes(data)[:16]}",
        acl=acl,
        background=background,
    )


def ingest_text(
    db: Session,
    principal: Principal,
    text: str,
    title: str | None = None,
    acl: list[str] | None = None,
    background: bool = True,
) -> dict:
    parsed = parse_text_content(text, title=title)
    return ingest_parsed(
        db,
        principal,
        parsed,
        source_type="text",
        uri=None,
        acl=acl,
        background=background,
    )


def ingest_url(
    db: Session,
    principal: Principal,
    url: str,
    title: str | None = None,
    acl: list[str] | None = None,
    background: bool = True,
) -> dict:
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("仅支持 http/https URL")
    response = httpx.get(
        url,
        timeout=20,
        follow_redirects=True,
        headers={"User-Agent": "KnoWeave/0.1"},
    )
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "pdf" in content_type or url.lower().endswith(".pdf"):
        parsed = parse_bytes(url, response.content, title=title)
        source_type = "pdf"
    else:
        parsed = parse_html(response.text, title or url)
        source_type = "web"
    return ingest_parsed(
        db,
        principal,
        parsed,
        source_type=source_type,
        uri=url,
        acl=acl,
        background=background,
    )


def tombstone_document(db: Session, principal: Principal, doc_id: str) -> dict:
    document = db.get(Document, doc_id)
    if not document or document.tenant_id != principal.tenant_id:
        raise ValueError("文档不存在")
    document.status = "tombstoned"
    document.updated_at = datetime.now(timezone.utc)
    evidence_rows = db.execute(
        select(FactEvidence).where(FactEvidence.doc_id == doc_id)
    ).scalars()
    affected: set[str] = set()
    for evidence in evidence_rows:
        affected.add(evidence.fact_id)
        db.delete(evidence)
    for fact_id in affected:
        remaining = db.execute(
            select(FactEvidence).where(FactEvidence.fact_id == fact_id)
        ).scalars().all()
        if not remaining:
            fact = db.get(Fact, fact_id)
            if fact:
                fact.status = "retracted"
    job = Job(
        id=new_id("job"),
        tenant_id=principal.tenant_id,
        type="tombstone",
        status="done",
        payload={"doc_id": doc_id, "affected_facts": sorted(affected)},
    )
    db.add(job)
    db.commit()
    return {"document_id": doc_id, "affected_facts": len(affected), "status": "tombstoned"}
