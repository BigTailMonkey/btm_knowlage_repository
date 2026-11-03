"""First-run demo workspace and golden evaluation cases."""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import (
    Budget,
    Chunk,
    Document,
    EvalCase,
    Fact,
    FactEvidence,
    ModelPrice,
    ReviewItem,
    Tenant,
    User,
    new_id,
)
from .security import Principal
from .learning import get_or_create_entity

PUBLIC = ["tenant:public"]
FINANCE = ["group:finance"]

DOC_OVERVIEW = """# 知织 KnoWeave · 产品总览

## 一句话定位

KnoWeave（知织）是一个以事实为中心的个人 AI 知识库。它不是又一个 RAG 聊天框，而是一套围绕「文档层 + 事实层」构建、可以增量演化、越用越准的知识基础设施。

## 双层架构

KnoWeave 采用双层架构：文档层负责结构化解析与可追溯引用，事实层负责实体、关系、断言的增量合并与冲突仲裁。文档层保证每个结论都能落到具体 chunk、原文页码与字符区间；事实层保证新知识以实体和事实为单位并入旧知识，而不是不断堆积切片。

## 架构铁律

KnoWeave 使用 PostgreSQL 作为唯一真相源。Qdrant 里的向量、图里的边、缓存里的摘要，全部是可重建的派生索引。任何时候删掉向量库，都能从 PostgreSQL 重建。第二条铁律是权限在检索之前生效，每个 chunk 与事实都带 tenant_id 和 acl_scope。

## 组件选型

KnoWeave 采用 Qdrant 作为向量索引，使用 BGE-M3 同时提供稠密与稀疏向量。解析与向量化下沉到无状态的 Python 边车，主路径不跨语言依赖。大模型交互由内嵌的 DeepSeek Harness 负责，业务代码只依赖 LLMHarness 接口。

## 对外能力

KnoWeave 同时提供 REST API 与 MCP 工具。人通过 Web UI 使用，Agent 通过 MCP 使用，脚本通过 REST 使用，三者共用同一套检索与学习逻辑。

## 里程碑

M0 解决「可问」：文档接入、结构切块、混合检索、引用式问答、轨迹与成本账本。M1 解决「可运营」，M2 解决「会学习」，M3 解决「可共享」。
"""

DOC_RETRIEVAL = """# 检索与问答链路

## 四路召回

默认链路是混合召回、RRF 融合、交叉编码器重排、证据门控、引用式生成。稠密召回使用 BGE-M3 语义向量，稀疏召回使用 BGE-M3 的 lexical weights，图谱召回沿实体关系走 1 到 2 跳，结构化过滤按来源与时间范围裁剪候选。

## RRF 融合

融合使用 Reciprocal Rank Fusion，公式为 score(d) = Σ 1 / (k + rank_i(d))，k 取 60。RRF 对不同分数量纲不敏感，比手工加权稳定。融合后取前 30 交给重排器，最终只保留 3 到 8 条进入上下文。

## 召回之前先过滤

租户与 ACL 作为向量检索的过滤条件参与召回，而不是先取 top 50 再在应用层剔除。后者既漏召回，也容易在缓存与日志里留下越权内容。语义缓存的 key 必须包含租户、主体与 acl_version。

## 证据门控

重排分数低于阈值、或证据之间互相矛盾且无法仲裁时，系统输出「现有资料不足以回答」，并给出最接近的 2 到 3 条线索与缺失方向。默认重排阈值为 0.36，可按评测集标定。

## 回答契约

每个事实性句子至少绑定一个引用；引用可点击跳转到原文页码与高亮区间。答案区分「资料明确支持」与「根据常识推断」，后者必须显式标注。涉及时间的问题按事实的 valid_from 与 valid_to 过滤，支持「截至某年」的问答。

## 五种查询模式

快速模式走单轮混合召回与重排，适合定义和参数查询。深度模式做问题拆解与多轮检索，适合跨文档比较。图谱模式做实体链接与 k 跳。时间线模式按事实有效期过滤。对比模式做多实体并行召回。
"""

DOC_LEARNING = """# 自动学习机制

## 双时间轴

每条事实都是带证据的断言，同时记录有效时间与记录时间。有效时间表示这条事实在现实世界里何时为真，记录时间表示系统何时知道它。这样既能回答现在是什么，也能回答当时是什么，还能在数据修正时保留完整历史。

## 合并五步

第一步从新 chunk 中抽取实体、关系与断言，强制附带出处、原文引用和置信度。第二步做实体对齐，先查别名表，再用向量找候选，最后让 LLM 裁决。第三步做冲突检测：同一主语加同一谓词但宾语不同，且有效时间重叠，即视为冲突。第四步仲裁与写入。第五步重算受影响实体的摘要，失效相关问答缓存。

## 冲突仲裁策略

新事实且无冲突时自动写入并追加证据。同一实体的不同写法自动合并别名。时间演进时，旧事实写 valid_to，新事实生效。多源数值矛盾按来源可信度与多源一致性投票。单源、低置信或与高可信来源冲突时标记 disputed，进入审阅队列。

## 保守合并原则

能自动合并的只有无冲突和明确时间演进两类。其余一律不覆盖，只标记争议。错误覆盖的代价远高于多一条待审记录，知识库的信任是一次性消耗品。

## 三个学习回路

文档学习由新文档或文档更新触发，只跑变化部分。对话学习在用户说「记住这个」、纠正答案或表达偏好时写入 memory_items，记忆默认不污染知识层，经过复述或审阅后才晋升为事实。反思巩固是夜间任务，合并重复实体、扫描冲突、重算摘要、发现知识缺口。

## 分级富化

所有文档都做解析、切块与向量化，只有高价值文档才做完整实体与关系抽取。这样既控制 LLM 成本，也避免低质量资料污染知识图谱。
"""

DOC_PERMISSION = """# 权限与多租户规范

## 权限模型

主体可以是 user、group 或 service account，Agent 与 MCP 客户端也是主体，必须有独立 scope。资源包括 workspace、folder、document、chunk、fact 与 memory。动作分为 read、ask、manage、admin。授权项写入 acl_entries，默认拒绝，目录授权向子文档继承。

## chunk 与事实的权限

chunk 与事实不单独授权，而是继承文档 ACL 并冗余成 acl_scope 写入索引，这样检索时不需要回表。一条事实可能由多份文档支撑，可见性取证据文档权限的交集，而不是并集。能同时读到 A 和 B 的人才看得到 A 加 B 推出的事实。

## 三道闸门

第一道是入口身份与租户校验。第二道是检索前过滤：Qdrant 的 payload filter 在向量检索时生效，PostgreSQL 用行级安全兜底。第三道是输出前复核：引用渲染前再查 ACL，缓存 key 含权限指纹，被拒候选数写 trace。

## 权限变更传播

文档授权变化时 acl_version 加一，异步重刷索引 payload；重刷完成前旧版本标记 stale。缓存按 doc_id 与 acl_version 精确失效，不做全清。在途请求响应前复核，权限已撤销则丢弃结果并返回 403。

## 边界情况

管理员 break-glass 需要二次确认、限时与全量审计，不做常驻超级权限。Agent 以调用者身份运行，不能自带 ACL。分享链接使用签名 token 并绑定具体资源与有效期。个人记忆不得被其他用户检索到。
"""

DOC_OLD_VECTOR = """# 技术选型备忘（2026 上半年）

## 向量库初选

在 2026 年上半年，KnoWeave 采用 pgvector 作为向量索引。选择 pgvector 的原因是部署简单，可以直接复用 PostgreSQL 的连接与备份体系，单机即可运行。团队在 2026 年 3 月完成了第一版混合检索验证。

## 当时的限制

pgvector 在十万级 chunk 规模下仍然可用，但稀疏向量与多命名向量的表达能力有限。过滤条件复杂时查询计划不够稳定，快照与按租户恢复也需要额外脚本。该方案的有效期到 2026 年 6 月 30 日。
"""

DOC_MIGRATION = """# 向量库迁移记录（2026 下半年）

## 迁移结论

自 2026 年 7 月 1 日起，KnoWeave 采用 Qdrant 作为向量索引。迁移的原因是 Qdrant 原生支持命名向量、payload 过滤与快照备份，适合稠密与稀疏混合召回。PostgreSQL 仍然是唯一真相源，Qdrant 只保存可重建的派生向量。

## 迁移过程

迁移分三步：先按租户导出 chunk 与向量，再用双写校验召回一致性，最后切换读路径并保留一周回滚窗口。迁移期间问答链路没有停机。按租户恢复测试通过，未出现跨租户数据混入。

## 成本

Qdrant 单机部署在现有 CPU 服务器上，月度增量成本约为 80 元。相比继续使用 pgvector，复杂过滤场景的 p95 延迟下降了约 35%。
"""

DOC_FINANCE = """# 2026 年 Q3 财务简报

## 收入

2026 年第三季度，知织团队实现营收 480 万元，同比增长 62%。收入主要来自企业知识库订阅与私有化部署项目，其中订阅收入占比 58%。

## 成本与预算

2026 年 Q3 研发预算为 120 万元，实际支出 108 万元。模型与向量化 API 成本为 14 万元，占研发支出的 13%。服务器与存储成本为 9 万元。

## 客户

截至 2026 年 9 月 30 日，付费客户数为 32 家，其中 8 家为年度合约。客户续约率为 91%，净收入留存率为 118%。

## 风险

前三大客户贡献了 41% 的收入，客户集中度偏高。下季度将把销售与交付资源向中型客户倾斜，同时控制模型调用成本。

本文件仅财务组可见，不得对外分享。
"""

DOC_OPS = """# 运维与成本手册

## 轨迹与回放

每个请求生成一个 trace_id，每个阶段生成一个 span_id。意图识别、每一路召回、RRF、重排、权限判定、生成与引用校验都要留痕。轨迹包含输入、参数、模型版本、召回候选、权限判定、输出与成本。失败 trace 可以一键转为回归用例。

## 成本账本

每次 LLM、Embedding、重排、OCR、ASR 调用都追加一行 usage_ledger，记录 trace_id、租户、用户、功能、tokens、单价快照与金额。单价表按生效区间版本化，调价只新增版本，不改历史成本。预算达到 80% 预警，100% 降级到快速模式或排队，不直接报错。

## 默认阈值

运维侧曾把默认重排阈值临时调整为 0.42，用于观察拒答率。该调整尚未经过评测集验证，因此与产品文档中的 0.36 存在争议，需要人工确认后统一。

## 夜间反思

反思任务每天运行一次，执行实体去重、冲突扫描、摘要重算、缺口发现与过期记忆清理。反思结果写入 reflection_runs，可在运维台查看。
"""

DOCS = [
    ("知织 KnoWeave · 产品总览", DOC_OVERVIEW, PUBLIC),
    ("检索与问答链路", DOC_RETRIEVAL, PUBLIC),
    ("自动学习机制", DOC_LEARNING, PUBLIC),
    ("权限与多租户规范", DOC_PERMISSION, PUBLIC),
    ("技术选型备忘（2026 上半年）", DOC_OLD_VECTOR, PUBLIC),
    ("向量库迁移记录（2026 下半年）", DOC_MIGRATION, PUBLIC),
    ("运维与成本手册", DOC_OPS, PUBLIC),
    ("2026 年 Q3 财务简报", DOC_FINANCE, FINANCE),
]

GOLDEN = [
    ("KnoWeave 的架构铁律是什么？", ["PostgreSQL", "唯一真相源"], ["产品总览"], False),
    ("KnoWeave 使用哪个向量数据库？", ["Qdrant"], ["向量库迁移记录"], False),
    ("KnoWeave 之前使用什么向量库，为什么迁移？", ["pgvector", "Qdrant"], ["技术选型", "迁移记录"], False),
    ("混合检索的四路召回分别是什么？", ["稠密", "稀疏", "图谱", "过滤"], ["检索与问答"], False),
    ("RRF 的 k 取值是多少？", ["60"], ["检索与问答"], False),
    ("证据门控在什么情况下拒答？", ["阈值", "证据"], ["检索与问答"], False),
    ("回答契约对引用有什么要求？", ["引用", "句子"], ["检索与问答"], False),
    ("事实的双时间轴分别是什么？", ["有效时间", "记录时间"], ["自动学习"], False),
    ("冲突仲裁里哪些情况可以自动合并？", ["无冲突", "时间演进"], ["自动学习"], False),
    ("三个学习回路是什么？", ["文档学习", "对话学习", "反思"], ["自动学习"], False),
    ("一条事实的可见性如何计算？", ["交集", "证据"], ["权限"], False),
    ("权限三道闸门分别是什么？", ["身份", "检索", "输出"], ["权限"], False),
    ("acl_version 变化时系统做什么？", ["失效", "重刷"], ["权限"], False),
    ("2026 年 Q3 营收是多少？", ["480"], ["财务"], False),
    ("2026 年 Q3 研发预算和实际支出是多少？", ["120", "108"], ["财务"], False),
    ("付费客户数是多少？", ["32"], ["财务"], False),
    ("默认重排阈值是多少？", ["0.36"], ["检索与问答"], False),
    ("轨迹里必须记录哪些内容？", ["召回", "成本"], ["运维"], False),
    ("预算达到上限时系统如何降级？", ["降级", "快速"], ["运维"], False),
    ("知识库是否支持音频转写？", [], [], True),
]


def seed_if_empty(db: Session):
    if db.scalar(select(Tenant).limit(1)):
        return
    tenant = Tenant(id=settings.default_tenant_id, name="知织工作区")
    db.add(tenant)
    users = [
        User(
            id="u_owner",
            tenant_id=tenant.id,
            name="何道伟",
            email="owner@knowweave.local",
            role="owner",
            groups=["everyone", "finance", "exec", "engineering"],
            token="owner-token",
        ),
        User(
            id="u_viewer",
            tenant_id=tenant.id,
            name="林澈",
            email="viewer@knowweave.local",
            role="viewer",
            groups=["everyone", "engineering"],
            token="viewer-token",
        ),
        User(
            id="u_outsider",
            tenant_id=tenant.id,
            name="外部访客",
            email="outsider@knowweave.local",
            role="viewer",
            groups=["guests"],
            token="outsider-token",
        ),
        User(
            id="u_agent",
            tenant_id=tenant.id,
            name="研究 Agent",
            email="agent@knowweave.local",
            role="service",
            groups=["everyone", "engineering"],
            token="agent-token",
        ),
    ]
    db.add_all(users)
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

    owner = Principal(
        user_id="u_owner",
        tenant_id=tenant.id,
        name="何道伟",
        role="owner",
        groups=("everyone", "finance", "exec", "engineering"),
        token="owner-token",
    )
    from .ingestion import ingest_text

    for title, text, acl in DOCS:
        ingest_text(db, owner, text, title=title, acl=acl, background=False)
        db.commit()
    _seed_facts(db, owner, tenant.id)
    _seed_reviews(db, owner, tenant.id)
    for question, keywords, docs, should_refuse in GOLDEN:
        db.add(
            EvalCase(
                tenant_id=tenant.id,
                question=question,
                expected_docs=docs,
                expected_keywords=keywords,
                should_refuse=should_refuse,
            )
        )
    db.commit()


def _doc_and_chunk(db: Session, title_keyword: str, quote: str):
    document = db.scalar(
        select(Document).where(Document.title.contains(title_keyword)).order_by(Document.created_at)
    )
    if not document:
        return None, None
    chunk = db.scalar(
        select(Chunk).where(
            Chunk.doc_id == document.id,
            Chunk.is_parent.is_(False),
            Chunk.text.contains(quote[:30]),
        )
    )
    if not chunk:
        chunk = db.scalar(
            select(Chunk).where(
                Chunk.doc_id == document.id, Chunk.is_parent.is_(False)
            ).order_by(Chunk.seq)
        )
    return document, chunk


def _fact(
    db: Session,
    tenant_id: str,
    subject: str,
    subject_type: str,
    predicate: str,
    obj: str | None,
    object_type: str | None,
    literal: str | None,
    confidence: float,
    doc_keyword: str,
    quote: str,
    valid_from: date | None = None,
    valid_to: date | None = None,
    status: str = "active",
    acl: list[str] | None = None,
) -> Fact:
    document, chunk = _doc_and_chunk(db, doc_keyword, quote)
    document_acl = list(document.acl_principals) if document else PUBLIC
    fact_acl = acl or document_acl
    subject_entity = get_or_create_entity(db, tenant_id, subject, subject_type, fact_acl)
    object_entity = (
        get_or_create_entity(db, tenant_id, obj, object_type or "concept", fact_acl)
        if obj
        else None
    )
    fact = Fact(
        id=new_id("f"),
        tenant_id=tenant_id,
        subject_id=subject_entity.id,
        predicate=predicate,
        object_id=object_entity.id if object_entity else None,
        object_literal=literal,
        valid_from=valid_from,
        valid_to=valid_to,
        recorded_at=datetime.now(timezone.utc),
        confidence=confidence,
        status=status,
        acl_principals=fact_acl,
        source_doc_id=document.id if document else None,
    )
    db.add(fact)
    db.flush()
    if document and chunk:
        db.add(
            FactEvidence(
                fact_id=fact.id,
                chunk_id=chunk.id,
                doc_id=document.id,
                quote=quote,
                weight=max(0.5, document.quality_score),
            )
        )
    return fact


def _seed_facts(db: Session, owner: Principal, tenant_id: str):
    pgvector = _fact(
        db, tenant_id, "KnoWeave", "product", "采用", "pgvector", "product", None,
        0.86, "技术选型", "KnoWeave 采用 pgvector 作为向量索引",
        date(2025, 1, 1), date(2026, 6, 30), "superseded",
    )
    qdrant = _fact(
        db, tenant_id, "KnoWeave", "product", "采用", "Qdrant", "product", None,
        0.92, "迁移记录", "KnoWeave 采用 Qdrant 作为向量索引",
        date(2026, 7, 1), None, "active",
    )
    pgvector.superseded_by = qdrant.id
    _fact(
        db, tenant_id, "KnoWeave", "product", "使用", "PostgreSQL", "product", None,
        0.93, "产品总览", "KnoWeave 使用 PostgreSQL 作为唯一真相源",
        date(2025, 1, 1),
    )
    _fact(
        db, tenant_id, "KnoWeave", "product", "使用", "BGE-M3", "product", None,
        0.88, "产品总览", "使用 BGE-M3 同时提供稠密与稀疏向量",
        date(2026, 1, 1),
    )
    _fact(
        db, tenant_id, "KnoWeave", "product", "采用", "双层架构", "concept", None,
        0.9, "产品总览", "KnoWeave 采用双层架构",
        date(2026, 1, 1),
    )
    _fact(
        db, tenant_id, "KnoWeave", "product", "提供", "REST API 与 MCP 工具", "concept", None,
        0.84, "产品总览", "KnoWeave 同时提供 REST API 与 MCP 工具",
        date(2026, 1, 1),
    )
    _fact(
        db, tenant_id, "检索链路", "concept", "使用", "RRF 融合", "concept", None,
        0.82, "检索与问答", "融合使用 Reciprocal Rank Fusion",
        date(2026, 1, 1),
    )
    _fact(
        db, tenant_id, "自动学习", "concept", "包含", "三个学习回路", "concept", None,
        0.8, "自动学习", "文档学习、对话学习与反思巩固",
        date(2026, 1, 1),
    )
    _fact(
        db, tenant_id, "事实可见性", "concept", "取", "证据文档权限的交集", "concept", None,
        0.87, "权限", "可见性取证据文档权限的交集",
        date(2026, 1, 1),
    )
    _fact(
        db, tenant_id, "知织团队", "org", "实现", "480 万元营收", "concept", None,
        0.8, "财务", "实现营收 480 万元", date(2026, 7, 1), date(2026, 9, 30),
        acl=FINANCE,
    )


def _seed_reviews(db: Session, owner: Principal, tenant_id: str):
    low = _fact(
        db, tenant_id, "KnoWeave", "product", "默认重排阈值", None, None, "0.36",
        0.74, "检索与问答", "默认重排阈值为 0.36",
        date(2026, 1, 1), None, "disputed",
    )
    high = _fact(
        db, tenant_id, "KnoWeave", "product", "默认重排阈值", None, None, "0.42",
        0.55, "运维", "默认重排阈值临时调整为 0.42",
        date(2026, 8, 1), None, "disputed",
    )
    db.add(
        ReviewItem(
            tenant_id=tenant_id,
            kind="fact_conflict",
            title="KnoWeave · 默认重排阈值",
            payload={
                "subject": "KnoWeave",
                "predicate": "默认重排阈值",
                "new_fact_id": high.id,
                "old_fact_ids": [low.id],
                "new_object": "0.42",
                "old_objects": ["0.36"],
                "quote": "运维侧曾把默认重排阈值临时调整为 0.42",
                "reason": "产品文档与运维记录给出的默认阈值不同，且有效期重叠；按保守策略进入人工审阅。",
            },
        )
    )
    db.commit()
