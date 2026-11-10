# 系统架构与数据流

依据当前代码（`src/`、`sidecar/`、`knowweave/web/`、`src/db/schema.sql`）绘制。图中端口取 `config.example.toml` 的默认值。

## 1. 系统架构

```mermaid
flowchart TB
  subgraph ACCESS["接入端"]
    UI["知识库工作台<br/>knowweave/web · 单页应用"]
    DSHUI["AI 对话页<br/>iframe 加载 DSH 原生界面"]
    CLIENT["研究台 / 脚本调用方<br/>Bearer + /api/v1"]
    MCPC["外部 MCP 客户端<br/>JSON-RPC"]
    SYNC["目录同步 CLI<br/>scripts/sync-directory"]
  end

  subgraph MAIN["主服务 · Node.js / TypeScript · Fastify :8730"]
    direction TB
    AUTH["认证与 ACL<br/>core/security.ts<br/>Bearer → Principal · tenant / user / groups"]

    subgraph ROUTES["应用层 src/app/routes"]
      R_DOC["documents<br/>upload / text / url / jobs / reprocess / trash"]
      R_ASK["ask<br/>search / ask / conversations / feedback"]
      R_LEARN["learn<br/>entities / facts / graph / review / memory / gaps"]
      R_OPS["ops<br/>stats / traces / costs / evals / prices"]
      R_MCP["mcp<br/>tools/list · tools/call"]
      R_RT["realtime<br/>WebSocket 审阅计数"]
    end

    subgraph CORE["领域核心 src/core"]
      ING["ingestion<br/>摄入队列 + 解析检查点"]
      ENQ["enrichment-queue<br/>抽取队列（续跑 / 重试）"]
      LRN["learning<br/>候选事实 → 实体 → 合并 / 取代 / 审阅"]
      ER["entity-resolution<br/>名称向量候选 + 模型裁决"]
      RET["retrieval<br/>dense + sparse + 图遍历 → RRF → 重排"]
      ANS["answering<br/>quick / deep / graph / timeline / compare"]
      GRD["grounding<br/>逐句引用核验 + 语义复核"]
      LIFE["continuation · trash · reindexing<br/>沿革 / 回收站 / 索引重建"]
      MAINT["consolidation · scheduling<br/>摘要 / 每日维护 / 回收站清理"]
      OBS["tracing · extraction-progress<br/>轨迹 / 用量 / 进度"]
    end

    subgraph ADAPTERS["适配层 src/adapters"]
      EMB["embeddings<br/>ark / openai / hybrid"]
      RRK["reranking<br/>语义服务或规则重排"]
      PRS["parsing<br/>文本 / Markdown / HTML / 文件路由"]
      SCA["sidecar 客户端<br/>拉起 / 复用 / 健康检查"]
      HARN["harness<br/>模型调用 · 重试 · 用量记账"]
      DSHW["dsh-web<br/>子进程生命周期 · 身份绑定"]
    end
  end

  subgraph EXT["外部依赖与本地进程"]
    PG[("PostgreSQL<br/>文档 / 切块 / JSONB 向量<br/>实体 / 事实 / 队列 / 轨迹")]
    FILES[("data/<br/>原始文件 · 扩展工作区")]
    LLM["[model] OpenAI 兼容接口<br/>生成 · 抽取 · 校验 · 对话"]
    EMBSVC["[embedding] 向量服务<br/>或本地 BGE-M3 /embed"]
    RRSVC["[retrieval] rerank 服务<br/>未配置则规则重排"]
    SC["Python 解析边车 :8732<br/>/parse /ocr /asr /capabilities"]
    ENG["Docling · MinerU · pypdf<br/>python-docx · OCR · ASR"]
    DSHP["DSH 原生应用 :3081<br/>流式输出 · 工具 · 会话"]
  end

  UI --> AUTH
  DSHUI --> DSHP
  CLIENT --> AUTH
  SYNC --> AUTH
  MCPC --> R_MCP
  AUTH --> ROUTES
  ROUTES --> CORE
  CORE --> ADAPTERS
  ING --> R_RT
  R_LEARN --> R_RT
  ING --> PG
  CORE --> PG
  ING --> FILES
  LIFE --> FILES
  EMB --> EMBSVC
  RRK --> RRSVC
  HARN --> LLM
  SCA --> SC
  SC --> ENG
  DSHW --> DSHP
  DSHP -->|"MCP tools/call<br/>kb_search / kb_graph / kb_query_facts …"| R_MCP
```

要点：

- 只有一个 Node 主进程承载 API、队列 worker、维护定时器和 DSH / 边车的进程管理；没有独立的消息中间件，队列就是 `jobs` 表。
- 向量以 JSONB 存在 `chunks.dense / chunks.sparse`，没有启用 pgvector。
- DSH 原生对话不直连数据库，它通过 `POST /api/v1/mcp` 回到主服务的只读工具，沿用绑定身份的知识库 ACL。

## 2. 存储视图（核心表关系）

```mermaid
erDiagram
  tenants ||--o{ users : has
  documents ||--o{ document_versions : versions
  document_versions ||--o{ blocks : blocks
  document_versions ||--o{ chunks : chunks
  chunks ||--o| chunks : "parent_id 父子块"
  documents ||--o{ document_continuations : "前序 / 后续"
  entities ||--o{ entity_aliases : aliases
  entities ||--o{ facts : subject
  entities ||--o{ facts : object
  facts ||--o{ fact_evidence : evidence
  chunks ||--o{ fact_evidence : "quote + span"
  documents ||--o{ review_queue : "冲突待审"
  facts ||--o{ review_queue : "new_fact_id"
  documents ||--o{ jobs : "ingest / enrich / reflection"
  tenants ||--o{ traces : traces
  traces ||--o{ trace_spans : spans
  tenants ||--o{ knowledge_summaries : "实体 / 社区摘要"
  users ||--o{ memory_items : memory

  chunks {
    text dense
    text sparse
    text embedding_model
    int embedding_dim
    json acl_principals
    bool is_parent
  }
  facts {
    text predicate
    date valid_from
    date valid_to
    double confidence
    text status
    text superseded_by
  }
  fact_evidence {
    text quote
    json span
    double weight
  }
  review_queue {
    text kind
    json payload
    text status
  }
```

## 3. 数据流 A：文档摄入

```mermaid
flowchart TD
  A["上传文件 / 文本 / URL<br/>POST /documents/{upload,text,url}"] --> B["写 jobs<br/>type=ingest status=pending<br/>原始内容 base64 入库"]
  B --> C["ingest worker 轮询 2s<br/>FOR UPDATE SKIP LOCKED 领取<br/>心跳 30s · 失联 2min 回收 · 失败 10s 后重试 ≤3 次"]
  C --> D{"有解析检查点？"}
  D -->|"有"| E["复用已存 ParsedDocument"]
  D -->|"无"| F["解析<br/>文本 / MD / HTML 本地<br/>PDF · DOCX · 图片 · 音视频走边车 :8732"]
  F --> G["质量阈值 parsing.min_quality<br/>不达标 → 422 + 人工修正待审项"]
  E --> H["写入检查点<br/>jobs.payload.checkpoint"]
  G --> H
  H --> I["切分 core/chunking.ts<br/>≤512 token · 64 token 重叠<br/>表格 / 代码 / 公式原子化<br/>生成父块 + 子块"]
  I --> J["向量化 embedder.embedMany<br/>子块 → dense；非 hybrid 时 sparse = 本地词频"]
  J --> K["事务写入<br/>document_versions · blocks · chunks<br/>documents 版本号 +1 / enrichment_status=pending"]
  K --> L["入队 jobs type=enrich<br/>enrich:docId:version"]
  L --> M["返回任务视图（前端轮询 /documents/jobs）"]
  J -->|"向量失败"| N["回滚：不发布半套索引<br/>旧版本保持可用"]
  K --> O["TraceRecorder 记录<br/>ingest.parse / ingest.chunk"]
```

## 4. 数据流 B：事实与实体抽取

```mermaid
flowchart TD
  A["enrich worker 领取 jobs type=enrich"] --> B["读 documents.current_version 原文<br/>置 enrichment_status=running"]
  B --> C["续跑检查点 jobs.payload.checkpoint<br/>已完成批次 / 已合并候选 / 请求计数"]
  C --> D["分批抽取 extractionBatches<br/>按 chunk 组批，模型输出 JSON 候选"]
  D --> E["证据硬校验<br/>quote 必须是 chunk 原文子串<br/>主语 / 宾语必须出现在 quote 内<br/>valid_from < valid_to"]
  E --> F["模型结构校验 checkCandidates<br/>是否只是复述、谓语重复、宾语同义<br/>未给出判断的一律丢弃"]
  F --> G["逐条合并 mergeOrArbitrate"]
  G --> H["getOrCreateEntity<br/>规范化名精确匹配 → 别名匹配"]
  H -->|"未命中且开启 semantic_entities"| I["同租户 / 同类型 / 同 ACL 候选<br/>名称向量 cosine ≥ 0.8 取前 5"]
  I --> J["模型裁决 same_entity 且 confidence ≥ 0.9<br/>否则新建实体"]
  H -->|"命中"| K["复用实体"]
  J --> K
  K --> L["同 subject + predicate 查现有事实<br/>按宾语 / 字面量与有效期区间判重"]
  L --> M{"同一件事？"}
  M -->|"是"| N["合并：追加证据 fact_evidence<br/>独立来源加权更新置信度与有效期"]
  M -->|"否"| O["新建事实 status=disputed"]
  N --> P{"是否存在冲突事实？"}
  O --> P
  P -->|"无冲突"| Q["直接 active"]
  P -->|"冲突且多源一致 + 来源票更高 + 有效期更晚"| R["active，并 supersede 旧事实"]
  P -->|"其余冲突"| S["保持 disputed<br/>写 review_queue kind=fact_conflict"]
  Q --> T["删除 knowledge_summaries<br/>失效派生摘要"]
  R --> T
  S --> T
  T --> U["置 enrichment_status=done / empty<br/>抽取失败= failed + 原因"]
  S --> V["人工 resolveReview<br/>accept_new / supersede / reject_new / merge / dispute"]
  V --> W["consolidateKnowledge 重建摘要"]
```

## 5. 数据流 C：检索与问答

```mermaid
flowchart TD
  A["POST /ask 或 MCP kb_ask<br/>question · mode · as_of · doc_ids"] --> B["意图与子查询<br/>quick / deep / graph / timeline / compare"]
  B --> C["候选加载 loadCandidates<br/>按 as_of 选版本<br/>沿革链只保留当时有效的一篇"]
  C --> D["ACL 过滤 documents + chunks<br/>显式《标题》作为确定来源范围"]
  D -->|"无可读候选"| E["拒答"]
  D --> F["embedQuery 查询向量 + tokenize"]
  F --> G["dense 余弦 top 50"]
  F --> H["sparse 词频 / learned sparse top 50"]
  F --> I["实体链接 linkEntities<br/>按名称 token 匹配"]
  I --> J["图遍历 facts<br/>默认 2 跳 / 最多 3 跳<br/>只取有可见原文证据的有效事实"]
  G --> K["RRF 融合（k=60）"]
  H --> K
  J --> K
  K --> L["加权打分<br/>0.40 dense + 0.20 sparse + 0.24 词面覆盖<br/>+0.06 标题 +0.08 短语 +0.07 图来源<br/>+ chunk 权重 ±0.05"]
  L --> M["语义重排（配置了 rerank 服务）<br/>否则规则分"]
  M --> N{"top 分 ≥ rerank_threshold<br/>默认 0.36，deep/compare ×0.85"}
  N -->|"否"| E
  N -->|"是"| O["拼证据：命中块 + 父块上下文<br/>事实 + 社区摘要 + 个人记忆"]
  O --> P["harness 调 [model] 生成回答"]
  P --> Q["grounding 逐句核验<br/>引用编号 / 原文 / 数字 / 否定方向"]
  Q --> R{"通过？"}
  R -->|"否"| E
  R -->|"是"| S["可选独立模型语义复核"]
  S --> T["回填引用 citations<br/>记录 trace_spans + usage_ledger + budgets"]
  E --> T
  T --> U["返回引用区间：version_id + UTF-16 span"]
  U --> V["deep 模式未达阈值时 reflectQueries 补检索<br/>最多 3 轮"]
  V --> C
```

## 6. 数据流 D：删除 / 恢复 / 索引重建 / 每日维护

```mermaid
flowchart TD
  subgraph TRASH["回收站"]
    A["DELETE /documents/{id}"] --> B["documents.status=tombstoned<br/>记 deleted_at / deleted_by"]
    B --> C["当场清理 chunks 与向量 · fact_evidence<br/>失去唯一出处的事实撤回<br/>只由该文档支撑的待审项关闭"]
    C --> D{"保留期 trash.retention_days"}
    D -->|"恢复"| E["用已存 blocks 重新切分 → 重新向量化<br/>→ 重新入队 enrich<br/>向量失败则不恢复"]
    D -->|"到期或手动彻底删除"| F["删除文档 / 版本 / blocks / chunks<br/>原始文件 · 孤立实体 · 引用 · 评测期望"]
  end

  subgraph REINDEX["索引重建"]
    G["POST /documents/{id}/reprocess<br/>scope=index | facts | all"] --> H["reindexing：用所有已存版本的子块重算向量<br/>事务替换，保留 chunk ID 与事实证据"]
    H -->|"向量失败"| I["不发布半套索引"]
    G --> J["scope=facts：重新入队 enrich"]
  end

  subgraph MAINT["每日维护 scheduling.ts"]
    K["reflection.run_at 默认 03:00<br/>每分钟检查，按工作区时区"] --> L["按租户领取<br/>jobs id=reflection:tenant:date"]
    L --> M["purgeExpiredTrash<br/>清理过期回收站"]
    M --> N["runReflection<br/>同名实体合并 · 冲突事实置 disputed 并补建待审项<br/>consolidateKnowledge：ACL 分区摘要重算<br/>撤回失去出处的事实 · 证据权重衰减<br/>缺口聚类 · 过期记忆清理 · 写 reflection_runs"]
    N --> O["写入 jobs 完成状态<br/>重启后补跑"]
  end
```

## 7. 关键不变量

| 项 | 约定 |
|---|---|
| 向量范围 | 只有 `chunks` 存向量；`facts` / `entities` 无向量列，靠主键关系 + 词面匹配检索 |
| 抽取期向量 | 仅 `resolveSemanticEntity` 临时嵌入实体名，用完丢弃，不落库 |
| 事实生效 | 无冲突即 `active`；只有冲突且无法按来源票自动取代才进 `review_queue` |
| 证据 | 每条事实必须挂在 `fact_evidence`，quote 是 chunk 原文子串，span 为 UTF-16 区间 |
| ACL | 文档与 chunk 各带 `acl_principals` / `acl_version`，检索与事实读取都要过 `canRead` |
| 幂等 | 同一来源内容哈希相同 → 跳过；任务领取用 `FOR UPDATE SKIP LOCKED`，抽取按 `tenant:doc:version` 去重 |
| 可观测 | 每次摄入 / 抽取 / 问答写 `traces` + `trace_spans`，模型用量写 `usage_ledger` 并累计 `budgets` |