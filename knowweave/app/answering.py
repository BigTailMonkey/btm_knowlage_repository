"""Retrieval-grounded answering with citations, evidence gating and refusal."""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .embeddings import tokenize
from .harness import harness, require_model_text
from .models import (
    Budget,
    Citation,
    Conversation,
    Gap,
    MemoryItem,
    Message,
    new_id,
)
from .retrieval import Hit, RetrievalResult, retrieve
from .security import Principal
from .tracing import TraceRecorder

CITATION = re.compile(r"\[(\d{1,2})\]")
REFUSAL_MARKERS = ("REFUSE", "资料不足", "不足以回答", "无法回答", "没有足够")
FOLLOW_UP = re.compile(r"(它|他|她|这|那|该|此|其|上面|刚才|之前|上述|前面|还有|继续|再|那么)")

SYSTEM = """你是 KnoWeave（知织）知识库的问答引擎。规则：
1. 只能使用给定的「证据」回答，不得使用训练知识补全，不得编造。
2. 每个事实性句子末尾用 [编号] 标注引用，编号必须是证据编号；一句话可引用多条。
3. 若证据不足以支撑结论，只输出一行：REFUSE: <缺失原因>。
4. 回答使用中文，先给结论，再给 2-4 句关键依据；不要复述整段原文。
5. 区分「资料明确支持」与「推测」；推测必须标注「（推测）」。
6. 涉及时间时按事实有效期判断，不要混用已经失效的旧结论。
7. 多轮对话中的历史消息仅用于理解指代，不得作为证据；引用编号只对应本轮证据。"""


def _format_evidence(hits: list[Hit], facts: list[dict], memories: list[MemoryItem]) -> str:
    blocks: list[str] = []
    for index, hit in enumerate(hits, start=1):
        heading = " / ".join(hit.chunk.heading_path) or "正文"
        page = f"第 {hit.chunk.page} 页 | " if hit.chunk.page else ""
        blocks.append(
            f"[{index}] 《{hit.document.title}》 | {page}章节：{heading}\n"
            f"{(hit.parent_text or hit.chunk.text)[:1600]}"
        )
    if facts:
        lines = ["\n图谱事实（来自事实层，需与证据交叉验证）："]
        for fact in facts[:12]:
            period = ""
            if fact["valid_from"] or fact["valid_to"]:
                period = f"（有效期 {fact['valid_from'] or '?'} → {fact['valid_to'] or '至今'}）"
            lines.append(
                f"- {fact['subject']} {fact['predicate']} {fact['object'] or ''}"
                f"{period}，状态 {fact['status']}，置信度 {fact['confidence']:.2f}"
            )
        blocks.extend(lines)
    if memories:
        blocks.append("\n用户记忆（仅用于理解偏好，不作为事实引用）：")
        for memory in memories[:5]:
            blocks.append(f"- {memory.text}")
    return "\n\n".join(blocks)


def _memory_context(db: Session, principal: Principal, question: str) -> list[MemoryItem]:
    rows = db.execute(
        select(MemoryItem).where(
            MemoryItem.tenant_id == principal.tenant_id,
            MemoryItem.user_id == principal.user_id,
        )
    ).scalars()
    query_tokens = set(tokenize(question))
    matches = []
    for memory in rows:
        tokens = set(tokenize(memory.text))
        if tokens and len(tokens & query_tokens) >= max(1, min(3, len(tokens) // 3)):
            matches.append(memory)
    return matches[:5]


def _conversation_history(db: Session, conversation: Conversation | None) -> list[Message]:
    if conversation is None:
        return []
    rows = db.execute(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at.desc())
        .limit(6)
    ).scalars().all()
    return list(reversed(rows))


def _history_context(messages: list[Message]) -> str:
    lines = ["对话历史（仅用于理解指代，不作为证据）："]
    for message in messages:
        role = "用户" if message.role == "user" else "助手"
        lines.append(f"{role}：{' '.join(message.content.split())[:500]}")
    return "\n".join(lines)


def _retrieval_question(question: str, messages: list[Message]) -> str:
    previous = next(
        (message.content for message in reversed(messages) if message.role == "user"),
        "",
    )
    if previous and (len(question) <= 12 or FOLLOW_UP.search(question)):
        return f"{previous} {question}"
    return question


def _refusal(hits: list[Hit]) -> str:
    if not hits:
        return "现有资料不足以回答这个问题：知识库中没有检索到相关证据。建议先补充相关文档或调整关键词。"
    clues = "；".join(f"《{hit.document.title}》" for hit in hits[:3])
    return (
        "现有资料不足以可靠地回答这个问题。"
        f"最接近的线索是：{clues}。"
        "这些片段没有形成一致的证据链，因此不做推测性回答。"
    )


def _confidence(answer: str, hits: list[Hit], refused: bool) -> float:
    if refused or not hits:
        return 0.18
    cited = {int(match) for match in CITATION.findall(answer)}
    valid = {index for index in cited if 1 <= index <= len(hits)}
    coverage = len(valid) / max(1, len(cited)) if cited else 0.0
    top = sum(hit.rerank for hit in hits[:3]) / min(3, len(hits))
    base = 0.28 + 0.45 * top + 0.20 * coverage + 0.07 * min(1.0, len(valid) / 3)
    if not cited:
        base -= 0.08
    return round(max(0.05, min(0.96, base)), 3)


def _upsert_gap(db: Session, principal: Principal, question: str):
    normalized = " ".join(question.strip().lower().split())
    gap = db.scalar(
        select(Gap).where(
            Gap.tenant_id == principal.tenant_id,
            Gap.question == normalized,
            Gap.status == "open",
        )
    )
    if gap:
        gap.count += 1
    else:
        db.add(
            Gap(
                tenant_id=principal.tenant_id,
                question=normalized,
                count=1,
                suggested_sources=["补充与该问题直接相关的原始文档", "检查是否缺少定义或时效信息"],
            )
        )


def _subqueries(question: str, mode: str) -> list[str]:
    if mode not in {"deep", "compare"}:
        return [question]
    parts = re.split(r"[；;？?]|以及|并且|\bvs\b|对比|比较", question)
    parts = [part.strip() for part in parts if len(part.strip()) >= 4]
    if len(parts) <= 1:
        return [question]
    return [question] + parts[:3]


def ask(
    db: Session,
    principal: Principal,
    question: str,
    mode: str = "quick",
    top_k: int = 6,
    as_of: str | None = None,
    conversation_id: str | None = None,
    doc_ids: list[str] | None = None,
) -> dict:
    started = time.time()
    question = (question or "").strip()
    if not question:
        raise ValueError("问题不能为空")
    recorder = TraceRecorder(principal.tenant_id, principal.user_id, "ask", question)
    recorder.add_span("intent", params={"mode": mode, "as_of": as_of}, output={"question": question})

    conversation = db.get(Conversation, conversation_id) if conversation_id else None
    if conversation and (
        conversation.tenant_id != principal.tenant_id
        or conversation.user_id != principal.user_id
    ):
        raise ValueError("会话不存在")
    history = _conversation_history(db, conversation)
    retrieval_question = _retrieval_question(question, history)
    recorder.add_span(
        "context.history",
        output={
            "messages": len(history),
            "retrieval_question": retrieval_question,
        },
    )

    queries = _subqueries(retrieval_question, mode)
    results: list[RetrievalResult] = []
    merged: dict[str, Hit] = {}
    facts: list[dict] = []
    for index, query in enumerate(queries):
        result = retrieve(
            db,
            principal,
            query,
            top_k=top_k * 3 if mode in {"deep", "compare"} else top_k,
            as_of=as_of,
            recorder=recorder if index == 0 else None,
            mode=mode,
            doc_ids=doc_ids,
        )
        results.append(result)
        for hit in result.hits:
            if hit.chunk.id not in merged or hit.rerank > merged[hit.chunk.id].rerank:
                merged[hit.chunk.id] = hit
        for fact in result.facts:
            if fact not in facts:
                facts.append(fact)

    hits = sorted(merged.values(), key=lambda item: item.rerank, reverse=True)[:top_k]
    memories = _memory_context(db, principal, question)
    top_score = hits[0].rerank if hits else 0.0
    threshold = settings.rerank_threshold
    if mode in {"deep", "compare"}:
        threshold *= 0.85
    refused = not hits or top_score < threshold

    if refused:
        answer = _refusal(hits)
        citations: list[dict] = []
    else:
        evidence = _format_evidence(hits, facts, memories)
        history_block = f"{_history_context(history)}\n\n" if history else ""
        prompt = f"""{history_block}证据：
{evidence}

问题：{question}
回答模式：{mode}{f'；时间切片：{as_of}' if as_of else ''}

请严格按规则回答。"""
        generated = harness.complete(prompt, system=SYSTEM)
        generate_span = recorder.add_span(
            "answer.generate",
            params={"model": generated.model, "provider": generated.provider, "mode": mode},
            output={
                "ok": generated.ok,
                "error": generated.error,
                "tokens_out": generated.tokens_out,
                "text_preview": generated.text[:400],
            },
            latency_ms=generated.latency_ms,
            status="ok" if generated.ok else "error",
            input_value=prompt,
        )
        if generated.ok:
            recorder.record_usage(generated, "ask", "answer.generate", generate_span.id)
        if not generated.ok:
            recorder.finish(db, answer="", status="error")
            db.commit()
        text = require_model_text(generated, "问答生成")
        is_refusal = any(marker in text for marker in REFUSAL_MARKERS)
        if is_refusal:
            answer = _refusal(hits)
            refused = True
            citations = []
        else:
            answer = text
            indices = sorted({int(match) for match in CITATION.findall(answer)})
            valid = [index for index in indices if 1 <= index <= len(hits)]
            citations = []
            for index in valid:
                hit = hits[index - 1]
                citations.append(
                    {
                        "index": index,
                        "chunk_id": hit.chunk.id,
                        "doc_id": hit.document.id,
                        "doc_title": hit.document.title,
                        "page": hit.chunk.page,
                        "heading_path": hit.chunk.heading_path,
                        "quote": hit.chunk.text[:420],
                        "rerank": hit.rerank,
                    }
                )
            if not valid or len(valid) != len(indices):
                answer = "生成回答未通过核验：缺少有效的原文引用。"
                refused = True
                citations = []
        citation_span = recorder.add_span(
            "answer.citations",
            params={"evidence": len(hits)},
            output={"valid_citations": len(citations), "refused": refused},
        )

    confidence = _confidence(answer, hits, refused)
    if refused:
        _upsert_gap(db, principal, question)

    if conversation is None:
        conversation = Conversation(
            id=new_id("conv"),
            tenant_id=principal.tenant_id,
            user_id=principal.user_id,
            title=question[:80],
        )
        db.add(conversation)
        db.flush()
    db.add(
        Message(
            conversation_id=conversation.id,
            role="user",
            content=question,
            mode=mode,
            trace_id=recorder.trace_id,
        )
    )
    assistant = Message(
        id=new_id("msg"),
        conversation_id=conversation.id,
        role="assistant",
        content=answer,
        mode=mode,
        latency_ms=recorder.latency_ms,
        trace_id=recorder.trace_id,
        confidence=confidence,
    )
    db.add(assistant)
    db.flush()
    for rank, citation in enumerate(citations, start=1):
        db.add(
            Citation(
                message_id=assistant.id,
                chunk_id=citation["chunk_id"],
                doc_id=citation["doc_id"],
                quote=citation["quote"],
                page=citation.get("page"),
                rank=rank,
            )
        )

    recorder.meta = {
        "mode": mode,
        "top_score": top_score,
        "threshold": threshold,
        "refused": refused,
        "evidence_count": len(hits),
        "evidence_ids": [hit.chunk.id for hit in hits],
        "retrieval": [result.stats for result in results],
        "confidence": confidence,
        "citations": len(citations),
    }
    recorder.finish(db, answer=answer, status="refused" if refused else "ok")
    if recorder.usage:
        budget = db.scalar(
            select(Budget).where(
                Budget.tenant_id == principal.tenant_id, Budget.scope == "tenant"
            )
        )
        if budget:
            budget.used_amount += sum(row.amount for row in recorder.usage)
    db.commit()

    return {
        "answer": answer,
        "refused": refused,
        "confidence": confidence,
        "citations": citations,
        "evidence": [hit.to_dict() for hit in hits],
        "facts": facts[:8],
        "entities": [
            {"id": entity.id, "name": entity.canonical_name, "type": entity.type}
            for result in results
            for entity in result.entities
        ][:6],
        "conversation_id": conversation.id,
        "message_id": assistant.id,
        "trace_id": recorder.trace_id,
        "latency_ms": int((time.time() - started) * 1000),
        "mode": mode,
        "as_of": as_of,
        "stats": {
            "top_score": round(top_score, 4),
            "threshold": round(threshold, 4),
            "evidence_count": len(hits),
            "rejected_candidates": sum(result.rejected_candidates for result in results),
            "subqueries": queries,
        },
        "grounding": {
            "citation_coverage": len(citations) / max(1, len(hits)),
            "note": "每个事实性句子应绑定引用；未逐句引用时已显式提示。",
        },
    }
