"""Shared response serializers."""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Chunk, Document, DocumentVersion, Entity, Fact, FactEvidence
from .security import acl_label


def document_dict(db: Session, document: Document) -> dict:
    chunk_count = db.scalar(
        select(func.count(Chunk.id)).where(
            Chunk.doc_id == document.id,
            Chunk.is_parent.is_(False),
            Chunk.version_id.in_(
                select(DocumentVersion.id).where(
                    DocumentVersion.doc_id == document.id,
                    DocumentVersion.version == document.current_version,
                )
            ),
        )
    )
    return {
        "id": document.id,
        "title": document.title,
        "source_type": document.source_type,
        "uri": document.uri,
        "status": document.status,
        "version": document.current_version,
        "content_hash": document.content_hash[:16],
        "acl": document.acl_principals,
        "acl_label": acl_label(document.acl_principals),
        "acl_version": document.acl_version,
        "quality": round(document.quality_score, 3),
        "enrichment_status": document.enrichment_status,
        "summary": document.summary,
        "chunks": chunk_count or 0,
        "created_at": document.created_at.isoformat() if document.created_at else None,
        "updated_at": document.updated_at.isoformat() if document.updated_at else None,
    }


def entity_dict(entity: Entity) -> dict:
    return {
        "id": entity.id,
        "name": entity.canonical_name,
        "type": entity.type,
        "description": entity.description,
        "status": entity.status,
        "acl": entity.acl_principals,
        "acl_label": acl_label(entity.acl_principals),
        "created_at": entity.created_at.isoformat() if entity.created_at else None,
    }


def fact_dict(db: Session, fact: Fact) -> dict:
    subject = db.get(Entity, fact.subject_id)
    obj = db.get(Entity, fact.object_id) if fact.object_id else None
    evidence = db.execute(
        select(FactEvidence).where(FactEvidence.fact_id == fact.id)
    ).scalars().all()
    return {
        "id": fact.id,
        "subject_id": fact.subject_id,
        "subject": subject.canonical_name if subject else fact.subject_id,
        "subject_type": subject.type if subject else "concept",
        "predicate": fact.predicate,
        "object_id": fact.object_id,
        "object": obj.canonical_name if obj else fact.object_literal,
        "object_literal": fact.object_literal,
        "valid_from": str(fact.valid_from) if fact.valid_from else None,
        "valid_to": str(fact.valid_to) if fact.valid_to else None,
        "recorded_at": fact.recorded_at.isoformat() if fact.recorded_at else None,
        "confidence": round(fact.confidence, 3),
        "status": fact.status,
        "superseded_by": fact.superseded_by,
        "source_doc_id": fact.source_doc_id,
        "acl": fact.acl_principals,
        "acl_label": acl_label(fact.acl_principals),
        "evidence": [
            {"chunk_id": row.chunk_id, "doc_id": row.doc_id, "quote": row.quote}
            for row in evidence
        ],
    }


def chunk_dict(chunk: Chunk, document: Document | None = None) -> dict:
    return {
        "id": chunk.id,
        "doc_id": chunk.doc_id,
        "doc_title": document.title if document else "",
        "seq": chunk.seq,
        "heading_path": chunk.heading_path,
        "page": chunk.page,
        "block_type": chunk.block_type,
        "text": chunk.text,
        "tokens": chunk.token_count,
        "acl_label": acl_label(chunk.acl_principals),
        "acl_version": chunk.acl_version,
    }
