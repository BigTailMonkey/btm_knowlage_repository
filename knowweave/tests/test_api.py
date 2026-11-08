"""End-to-end API tests over the seeded demo workspace."""
from __future__ import annotations

import json
import time

from conftest import AGENT, OUTSIDER, OWNER, VIEWER


def _wait_ingest(client, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        items = client.get("/api/v1/documents/jobs", headers=OWNER).json()["items"]
        job = next((item for item in items if item["job_id"] == job_id), None)
        if job and job["status"] in {"done", "failed"}:
            assert job["status"] == "done", job.get("error")
            return job
        time.sleep(0.05)
    raise AssertionError(f"ingest job {job_id} did not finish in time")


def test_health_and_identity(client):
    assert client.get("/api/v1/health").json()["status"] == "ok"
    me = client.get("/api/v1/auth/me", headers=OWNER).json()
    assert me["role"] == "owner"
    assert "group:finance" in me["principals"]
    assert client.get("/api/v1/auth/me").status_code == 401
    assert (
        client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer bad-token"}
        ).status_code
        == 401
    )
    assert client.get("/", follow_redirects=True).status_code == 200


def test_library_visibility(client):
    owner_docs = client.get("/api/v1/documents", headers=OWNER).json()
    viewer_docs = client.get("/api/v1/documents", headers=VIEWER).json()
    owner_titles = [item["title"] for item in owner_docs["items"]]
    viewer_titles = [item["title"] for item in viewer_docs["items"]]
    assert len(owner_titles) >= 8
    assert any("财务" in title for title in owner_titles)
    assert not any("财务" in title for title in viewer_titles)
    assert len(owner_titles) == len(viewer_titles) + 1


def test_search_is_acl_filtered_before_ranking(client):
    payload = {"query": "2026 年 Q3 营收是多少？", "top_k": 8}
    owner = client.post("/api/v1/search", json=payload, headers=OWNER).json()
    viewer = client.post("/api/v1/search", json=payload, headers=VIEWER).json()
    outsider = client.post("/api/v1/search", json=payload, headers=OUTSIDER).json()
    assert any("财务" in hit["doc_title"] for hit in owner["hits"])
    assert not any("财务" in hit["doc_title"] for hit in viewer["hits"])
    assert not any("财务" in hit["doc_title"] for hit in outsider["hits"])
    assert owner["stats"]["top_score"] >= viewer["stats"]["top_score"]


def test_ask_returns_grounded_citations_and_trace(client):
    response = client.post(
        "/api/v1/ask",
        json={"question": "KnoWeave 使用哪个向量数据库？", "mode": "quick"},
        headers=OWNER,
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["refused"] is False
    assert payload["answer"]
    assert payload["evidence"]
    assert payload["confidence"] > 0.3
    assert payload["trace_id"].startswith("tr")
    trace = client.get(
        f"/api/v1/traces/{payload['trace_id']}", headers=OWNER
    ).json()
    assert trace["trace"]["feature"] == "ask"
    stages = [span["stage"] for span in trace["spans"]]
    assert {"recall.dense", "recall.sparse", "rank.rrf", "rank.rerank"} <= set(stages)


def test_ask_refuses_and_records_gap(client):
    response = client.post(
        "/api/v1/ask",
        json={"question": "知识库是否支持音频转写？", "mode": "quick"},
        headers=OWNER,
    )
    payload = response.json()
    assert payload["refused"] is True
    assert "不足" in payload["answer"]
    gaps = client.get("/api/v1/gaps", headers=OWNER).json()["items"]
    assert any("音频" in gap["question"] for gap in gaps)


def test_conversation_history(client):
    payload = client.post(
        "/api/v1/ask",
        json={"question": "RRF 的 k 取值是多少？", "mode": "quick"},
        headers=OWNER,
    ).json()
    detail = client.get(
        f"/api/v1/conversations/{payload['conversation_id']}", headers=OWNER
    ).json()
    assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][1]["content"]
    conversations = client.get("/api/v1/conversations", headers=OWNER).json()["items"]
    assert any(item["id"] == payload["conversation_id"] for item in conversations)


def test_upload_requires_editor_and_indexes_content(client):
    body = {
        "title": "新员工入门手册",
        "text": "# 新员工入门手册\n\n## 账号申请\n\n新员工入职第一天需要在 IT 系统提交账号申请，审批通过后领取设备。",
    }
    denied = client.post("/api/v1/documents/text", json=body, headers=VIEWER)
    assert denied.status_code == 403
    created = client.post("/api/v1/documents/text", json=body, headers=OWNER)
    assert created.status_code == 200
    job = _wait_ingest(client, created.json()["job_id"])
    doc_id = job["doc_id"]
    detail = client.get(f"/api/v1/documents/{doc_id}", headers=OWNER).json()
    assert detail["document"]["title"] == "新员工入门手册"
    assert detail["chunks"]
    search = client.post(
        "/api/v1/search", json={"query": "新员工账号申请"}, headers=OUTSIDER
    ).json()
    assert any(hit["doc_id"] == doc_id for hit in search["hits"])


def test_private_acl_document_is_hidden_from_outsider(client):
    created = client.post(
        "/api/v1/documents/text",
        json={
            "title": "董事会纪要",
            "text": "# 董事会纪要\n\n本季度将启动新一轮融资。",
            "acl": ["group:exec"],
        },
        headers=OWNER,
    )
    _wait_ingest(client, created.json()["job_id"])
    docs = client.get("/api/v1/documents", headers=OUTSIDER).json()["items"]
    assert not any(item["title"] == "董事会纪要" for item in docs)
    outsider_search = client.post(
        "/api/v1/search", json={"query": "董事会 融资"}, headers=OUTSIDER
    ).json()
    assert not any(
        hit["doc_title"] == "董事会纪要" for hit in outsider_search["hits"]
    )


def test_review_queue_and_resolution(client):
    items = client.get("/api/v1/review", headers=OWNER).json()["items"]
    assert items
    assert any("重排阈值" in item["title"] for item in items)
    review_id = items[0]["id"]
    resolved = client.post(
        f"/api/v1/review/{review_id}/resolve",
        json={"action": "dispute", "note": "保留争议，等待评测确认"},
        headers=OWNER,
    )
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "resolved"
    after = client.get("/api/v1/review", headers=OWNER).json()["items"]
    assert all(item["id"] != review_id for item in after)


def test_entity_graph_and_fact_timeline(client):
    entities = client.get("/api/v1/entities", headers=OWNER).json()["items"]
    knowweave = next(item for item in entities if item["name"] == "KnoWeave")
    detail = client.get(
        f"/api/v1/entities/{knowweave['id']}", headers=OWNER
    ).json()
    predicates = {fact["predicate"] for fact in detail["facts"]}
    assert "采用" in predicates
    timeline = client.get(
        f"/api/v1/entities/{knowweave['id']}?as_of=2026-05-01", headers=OWNER
    ).json()
    objects = [fact["object"] for fact in timeline["facts"]]
    assert "pgvector" in objects
    assert "Qdrant" not in objects
    graph = client.get("/api/v1/graph", headers=OWNER).json()
    assert graph["nodes"] and graph["edges"]
    finance_entities = client.get("/api/v1/entities", headers=OUTSIDER).json()["items"]
    assert not any(item["name"] == "知织团队" for item in finance_entities)


def test_entity_edit_and_delete(client):
    from app.config import settings
    from app.db import SessionLocal
    from app.learning import get_or_create_entity
    from app.models import Fact, new_id

    tenant = settings.default_tenant_id
    with SessionLocal() as db:
        temp = get_or_create_entity(db, tenant, "临时待清理实体", "concept", ["tenant:public"])
        holder = get_or_create_entity(db, tenant, "关联持有人", "concept", ["tenant:public"])
        db.add(
            Fact(
                id=new_id("f"), tenant_id=tenant, subject_id=temp.id, predicate="测试谓词",
                object_literal="值A", confidence=0.9, status="active",
                acl_principals=["tenant:public"],
            )
        )
        db.add(
            Fact(
                id=new_id("f"), tenant_id=tenant, subject_id=holder.id, predicate="关联",
                object_id=temp.id, confidence=0.9, status="active",
                acl_principals=["tenant:public"],
            )
        )
        db.commit()
        temp_id = temp.id

    edited = client.patch(
        f"/api/v1/entities/{temp_id}",
        json={"name": "订正后的实体", "type": "org", "description": "人工订正"},
        headers=OWNER,
    )
    assert edited.status_code == 200
    entity = edited.json()["entity"]
    assert entity["name"] == "订正后的实体"
    assert entity["type"] == "org"
    assert entity["description"] == "人工订正"

    # 旧名留作别名，之后再抽取到旧名仍归并到同一个实体
    with SessionLocal() as db:
        again = get_or_create_entity(db, tenant, "临时待清理实体", "concept", ["tenant:public"])
        db.commit()
        assert again.id == temp_id

    assert (
        client.patch(
            f"/api/v1/entities/{temp_id}", json={"name": "KnoWeave"}, headers=OWNER
        ).status_code
        == 409
    )
    retyped = client.patch(
        f"/api/v1/entities/{temp_id}", json={"type": "product"}, headers=OWNER
    )
    assert retyped.status_code == 200
    assert retyped.json()["entity"]["type"] == "product"
    assert client.delete(f"/api/v1/entities/{temp_id}", headers=VIEWER).status_code == 403

    removed = client.delete(f"/api/v1/entities/{temp_id}", headers=OWNER)
    assert removed.status_code == 200
    result = removed.json()
    assert result["facts_removed"] == 1
    assert result["facts_unlinked"] == 1
    remaining = client.get("/api/v1/entities", headers=OWNER).json()["items"]
    assert not any(item["id"] == temp_id for item in remaining)
    assert client.get(f"/api/v1/entities/{temp_id}", headers=OWNER).status_code == 404


def test_memory_and_reflection(client):
    created = client.post(
        "/api/v1/memory",
        json={"text": "回答时优先给出结论，再给依据"},
        headers=VIEWER,
    ).json()
    memories = client.get("/api/v1/memory", headers=VIEWER).json()["items"]
    assert any(item["id"] == created["id"] for item in memories)
    promoted = client.post(
        f"/api/v1/memory/{created['id']}/promote", headers=VIEWER
    ).json()
    assert promoted["status"] == "pending_review"
    reflection = client.post("/api/v1/reflection/run", headers=OWNER).json()
    assert "merged_entities" in reflection


def test_traces_costs_prices_and_budget(client):
    traces = client.get("/api/v1/traces", headers=OWNER).json()["items"]
    assert traces
    assert {"feature", "question", "status", "latency_ms"} <= set(traces[0])
    costs = client.get("/api/v1/costs/summary", headers=OWNER).json()
    assert "total_amount" in costs and "by_feature" in costs
    prices = client.get("/api/v1/prices", headers=OWNER).json()
    assert prices["items"] and prices["current_runtime"]["model"]
    stats = client.get("/api/v1/stats", headers=OWNER).json()
    assert stats["documents"] >= 8
    assert stats["facts_active"] >= 5


def test_ops_write_endpoints_require_admin(client):
    denied = client.post(
        "/api/v1/prices",
        json={"provider": "test", "model": "test", "input_per_1m": 1, "output_per_1m": 1},
        headers=AGENT,
    )
    assert denied.status_code == 403
    created = client.post(
        "/api/v1/prices",
        json={"provider": "test", "model": "test", "input_per_1m": 1, "output_per_1m": 1},
        headers=OWNER,
    )
    assert created.status_code == 200


def test_mcp_jsonrpc_tools(client):
    init = client.post(
        "/api/v1/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
        headers=AGENT,
    ).json()
    assert init["result"]["serverInfo"]["name"] == "knowweave"
    tools = client.post(
        "/api/v1/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        headers=AGENT,
    ).json()
    names = {tool["name"] for tool in tools["result"]["tools"]}
    assert {"kb_search", "kb_ask", "kb_get_document", "kb_add_note"} <= names
    called = client.post(
        "/api/v1/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "kb_search", "arguments": {"query": "RRF k 值"}},
        },
        headers=AGENT,
    ).json()
    payload = json.loads(called["result"]["content"][0]["text"])
    assert payload["hits"]
    timeline = client.post(
        "/api/v1/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "kb_entity_timeline", "arguments": {"name": "KnoWeave"}},
        },
        headers=AGENT,
    ).json()
    timeline_payload = json.loads(timeline["result"]["content"][0]["text"])
    assert timeline_payload["entity"] == "KnoWeave"


def test_golden_eval_run_meets_baseline(client):
    run = client.post("/api/v1/evals/run", headers=OWNER)
    assert run.status_code == 200
    payload = run.json()
    metrics = payload["metrics"]
    assert metrics["cases"] == 20
    assert metrics["doc_recall"] >= 0.75
    assert metrics["pass_rate"] >= 0.6
