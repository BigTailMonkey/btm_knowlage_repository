"""Minimal MCP (Model Context Protocol) server over JSON-RPC/HTTP.

Tools share the exact same ACL and retrieval logic as the Web UI and REST API.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .answering import ask as ask_service
from .api_documents import document_detail
from .db import get_db
from .models import Entity, Fact, Gap, MemoryItem
from .retrieval import retrieve
from .security import Principal, can_read, get_principal
from .serializers import fact_dict

router = APIRouter(tags=["mcp"])

TOOLS = [
    {
        "name": "kb_search",
        "description": "在用户可见的知识库中做混合检索，返回带 ACL 过滤的 chunk 引用。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "top_k": {"type": "integer", "default": 8},
            },
            "required": ["query"],
        },
    },
    {
        "name": "kb_ask",
        "description": "基于知识库回答并返回逐句引用；证据不足时明确拒答。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "mode": {
                    "type": "string",
                    "enum": ["quick", "deep", "graph", "timeline", "compare"],
                },
                "as_of": {"type": "string"},
            },
            "required": ["question"],
        },
    },
    {
        "name": "kb_get_document",
        "description": "读取一篇可见文档的结构、chunk 与事实。",
        "inputSchema": {
            "type": "object",
            "properties": {"doc_id": {"type": "string"}},
            "required": ["doc_id"],
        },
    },
    {
        "name": "kb_entity_timeline",
        "description": "查询实体的时间线事实与出处。",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "as_of": {"type": "string"}},
            "required": ["name"],
        },
    },
    {
        "name": "kb_add_note",
        "description": "写入一条个人记忆，默认不污染知识层。",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "kb_report_gap",
        "description": "上报一个知识缺口，进入运营台缺口清单。",
        "inputSchema": {
            "type": "object",
            "properties": {"question": {"type": "string"}},
            "required": ["question"],
        },
    },
]


class McpRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: str | int | None = None
    method: str
    params: dict | None = None


def _result(request_id, result) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id, code: int, message: str) -> JSONResponse:
    return JSONResponse(
        {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
    )


def _tool_result(payload: dict) -> dict:
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, ensure_ascii=False, default=str)}
        ],
        "isError": False,
    }


@router.post("/mcp")
def mcp_endpoint(
    payload: McpRequest,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    if payload.method == "initialize":
        return _result(
            payload.id,
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "knowweave", "version": "0.1.0"},
            },
        )
    if payload.method == "tools/list":
        return _result(payload.id, {"tools": TOOLS})
    if payload.method == "ping":
        return _result(payload.id, {})
    if payload.method != "tools/call":
        return _error(payload.id, -32601, f"method not found: {payload.method}")

    params = payload.params or {}
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        if name == "kb_search":
            result = retrieve(
                db,
                principal,
                str(arguments.get("query", "")),
                top_k=int(arguments.get("top_k") or 8),
            )
            return _result(
                payload.id,
                _tool_result(
                    {
                        "hits": [hit.to_dict() for hit in result.hits],
                        "facts": result.facts,
                        "stats": result.stats,
                    }
                ),
            )
        if name == "kb_ask":
            result = ask_service(
                db,
                principal,
                str(arguments.get("question", "")),
                mode=arguments.get("mode") or "quick",
                as_of=arguments.get("as_of"),
            )
            return _result(payload.id, _tool_result(result))
        if name == "kb_get_document":
            result = document_detail(
                str(arguments.get("doc_id", "")), principal=principal, db=db
            )
            return _result(payload.id, _tool_result(result))
        if name == "kb_entity_timeline":
            entity_name = str(arguments.get("name", ""))
            entity = db.scalar(
                select(Entity).where(
                    Entity.tenant_id == principal.tenant_id,
                    Entity.canonical_name.contains(entity_name),
                    Entity.status == "active",
                )
            )
            if not entity or not can_read(principal, entity.acl_principals):
                return _error(payload.id, -32004, "实体不存在或无权访问")
            facts = db.execute(
                select(Fact).where(Fact.subject_id == entity.id)
            ).scalars().all()
            return _result(
                payload.id,
                _tool_result(
                    {
                        "entity": entity.canonical_name,
                        "timeline": [
                            fact_dict(db, fact)
                            for fact in facts
                            if can_read(principal, fact.acl_principals)
                        ],
                    }
                ),
            )
        if name == "kb_add_note":
            memory = MemoryItem(
                tenant_id=principal.tenant_id,
                user_id=principal.user_id,
                scope="personal",
                kind="mcp_note",
                text=str(arguments.get("text", "")),
                confidence=0.5,
            )
            db.add(memory)
            db.commit()
            return _result(payload.id, _tool_result({"memory_id": memory.id}))
        if name == "kb_report_gap":
            gap = Gap(
                tenant_id=principal.tenant_id,
                question=" ".join(str(arguments.get("question", "")).lower().split()),
                count=1,
                suggested_sources=[],
            )
            db.add(gap)
            db.commit()
            return _result(payload.id, _tool_result({"gap_id": gap.id}))
        return _error(payload.id, -32602, f"unknown tool: {name}")
    except Exception as exc:  # noqa: BLE001 - MCP boundary
        db.rollback()
        return _error(payload.id, -32000, str(exc))
