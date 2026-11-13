-- KnoWeave PostgreSQL schema. Vectors are derived data stored as JSONB and can
-- always be rebuilt from chunks; only relational facts are authoritative.
-- 注释规范（见 AGENTS.md）：所有表和字段都必须有完整且准确的 COMMENT ON 注释；
-- 修改表结构时必须同步更新注释。COMMENT ON 可重复执行，随本脚本幂等刷新。

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenants IS '租户（工作区）表：多租户隔离的顶层单元，所有业务数据按 tenant_id 归属租户';
COMMENT ON COLUMN tenants.id IS '租户 ID（文本主键，默认工作区为配置 tenant.default_id，如 tn_knowweave）';
COMMENT ON COLUMN tenants.name IS '租户/工作区显示名称';
COMMENT ON COLUMN tenants.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'editor',
  groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_users_tenant ON users (tenant_id);
COMMENT ON TABLE users IS '用户表：租户内的访问主体，使用 token 鉴权；角色决定管理与写入权限';
COMMENT ON COLUMN users.id IS '用户 ID（u_ 前缀）';
COMMENT ON COLUMN users.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN users.name IS '用户显示名称';
COMMENT ON COLUMN users.email IS '邮箱（可空）';
COMMENT ON COLUMN users.role IS '角色：owner 所有者 / admin 管理员 / editor 编辑者（默认）；owner/admin 可管理，editor 可写入';
COMMENT ON COLUMN users.groups IS 'JSONB 字符串数组：所属权限组名（如 everyone、finance），用于 ACL 的 group:<组名> 匹配';
COMMENT ON COLUMN users.token IS 'API 访问令牌（全局唯一），请求鉴权凭据';
COMMENT ON COLUMN users.status IS '状态：active 可用；其他值视为停用，无法通过 token 鉴权';
COMMENT ON COLUMN users.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS acl_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  effect TEXT NOT NULL DEFAULT 'allow',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_acl_tenant ON acl_entries (tenant_id);
CREATE INDEX IF NOT EXISTS ix_acl_resource ON acl_entries (resource_id);
COMMENT ON TABLE acl_entries IS '细粒度 ACL 授权表（预留）：当前权限判定实际使用各资源表的 acl_principals 允许列表，本表尚未参与判定';
COMMENT ON COLUMN acl_entries.id IS '授权条目 ID';
COMMENT ON COLUMN acl_entries.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN acl_entries.resource_type IS '资源类型（如 document、chunk）';
COMMENT ON COLUMN acl_entries.resource_id IS '资源 ID';
COMMENT ON COLUMN acl_entries.principal_type IS '被授权主体类型（如 user、group、tenant）';
COMMENT ON COLUMN acl_entries.principal_id IS '被授权主体 ID';
COMMENT ON COLUMN acl_entries.permission IS '权限级别（默认 read）';
COMMENT ON COLUMN acl_entries.effect IS '授权效果：allow 允许 / deny 拒绝（默认 allow）';
COMMENT ON COLUMN acl_entries.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'text',
  uri TEXT,
  content_hash TEXT NOT NULL,
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  acl_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  current_version INTEGER NOT NULL DEFAULT 1,
  quality_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  enrichment_status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_documents_tenant ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS ix_documents_hash ON documents (content_hash);
COMMENT ON TABLE documents IS '文档主表：文档的当前状态与元数据；历史全文在 document_versions，检索单元在 chunks';
COMMENT ON COLUMN documents.id IS '文档 ID（doc_ 前缀）';
COMMENT ON COLUMN documents.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN documents.title IS '文档标题';
COMMENT ON COLUMN documents.source_type IS '来源类型：text 纯文本 / web 网页 / pdf、docx 等文件扩展名（小写）';
COMMENT ON COLUMN documents.uri IS '来源定位符（可空）：上传为 upload:<文件名>[:<内容哈希>]，网页为 URL，目录同步为 file:// URI，记忆晋升为 memory:<记忆ID>';
COMMENT ON COLUMN documents.content_hash IS '当前版本全文的 SHA-256 十六进制哈希，用于内容去重';
COMMENT ON COLUMN documents.acl_principals IS 'JSONB 字符串数组：允许读取的主体列表（user:<用户ID> / group:<组名> / tenant:public）；空数组表示默认拒绝';
COMMENT ON COLUMN documents.acl_version IS 'ACL 版本号：授权列表每次变化加 1，并同步写入该文档的 chunks';
COMMENT ON COLUMN documents.status IS '状态：active 在库 / tombstoned 已移入回收站';
COMMENT ON COLUMN documents.current_version IS '当前版本号，对应 document_versions.version';
COMMENT ON COLUMN documents.quality_score IS '解析质量分（0–1）：解析器对文本可解析程度的评估';
COMMENT ON COLUMN documents.enrichment_status IS '事实抽取状态：pending 待抽取 / running 抽取中 / done 完成 / empty 无可抽事实 / failed 失败 / deferred 历史遗留的延迟抽取状态（按来源策略或被引用时补抽）';
COMMENT ON COLUMN documents.summary IS '内容预览：当前版本全文的前 240 个字符（非模型生成摘要）';
COMMENT ON COLUMN documents.created_at IS '创建时间';
COMMENT ON COLUMN documents.updated_at IS '最近更新时间（内容或状态变化时刷新）';

-- 文档沿革：旧文档由新文档接续时登记一条有生效日期的边。每个文档最多一个
-- 前序和一个后续，形成线性链；检索按结算日期只保留当时有效的那一篇。
CREATE TABLE IF NOT EXISTS document_continuations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  predecessor_doc_id TEXT NOT NULL REFERENCES documents(id),
  successor_doc_id TEXT NOT NULL REFERENCES documents(id),
  effective_date DATE NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (predecessor_doc_id),
  UNIQUE (successor_doc_id)
);
CREATE INDEX IF NOT EXISTS ix_continuations_tenant ON document_continuations (tenant_id);
CREATE INDEX IF NOT EXISTS ix_continuations_effective ON document_continuations (tenant_id, effective_date);
COMMENT ON TABLE document_continuations IS '文档沿革（延续）边表：后续文档自生效日起接续前序文档；每文档最多一个前序和一个后续，形成线性链；检索按结算日期只保留当时有效的一篇';
COMMENT ON COLUMN document_continuations.id IS '延续边 ID（cont_ 前缀）';
COMMENT ON COLUMN document_continuations.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN document_continuations.predecessor_doc_id IS '前序（旧）文档 ID，唯一：一个文档最多有一个后续';
COMMENT ON COLUMN document_continuations.successor_doc_id IS '后续（新）文档 ID，唯一：一个文档最多接续一个前序';
COMMENT ON COLUMN document_continuations.effective_date IS '后续文档生效日期（YYYY-MM-DD）：该日起前序退出默认检索，后续进入默认检索';
COMMENT ON COLUMN document_continuations.note IS '备注（可空，最长 500 字符）';
COMMENT ON COLUMN document_continuations.created_by IS '创建者用户 ID';
COMMENT ON COLUMN document_continuations.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  parser TEXT NOT NULL,
  text TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_versions_doc ON document_versions (doc_id);
COMMENT ON TABLE document_versions IS '文档版本表：每次内容更新追加一个不可变版本，保存解析全文与元数据；历史查询按版本创建时间选取';
COMMENT ON COLUMN document_versions.id IS '版本 ID（ver_ 前缀）';
COMMENT ON COLUMN document_versions.doc_id IS '所属文档 ID';
COMMENT ON COLUMN document_versions.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN document_versions.version IS '版本号：从 1 递增，最新值等于 documents.current_version';
COMMENT ON COLUMN document_versions.hash IS '该版本全文的 SHA-256 十六进制哈希';
COMMENT ON COLUMN document_versions.parser IS '解析器名称：plain-text / markdown / html / docling / mineru 等';
COMMENT ON COLUMN document_versions.text IS '解析后的规范化全文（结构块以空行连接）；meta.chunk_spans 的偏移以此为基准';
COMMENT ON COLUMN document_versions.meta IS 'JSONB 解析元数据：chars/engine/pages、coordinate_system（normalized-text-utf16）、chunk_spans（chunk ID → 原文 UTF-16 偏移区间数组）、source_job_id、corrected_by 等';
COMMENT ON COLUMN document_versions.created_at IS '版本创建时间';

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  doc_id TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL DEFAULT 'paragraph',
  page INTEGER,
  bbox JSONB,
  order_index INTEGER NOT NULL DEFAULT 0,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_blocks_version ON blocks (version_id);
CREATE INDEX IF NOT EXISTS ix_blocks_doc ON blocks (doc_id);
COMMENT ON TABLE blocks IS '结构块表：解析器输出的文档结构单元；回收站恢复时据此重新切分与向量化';
COMMENT ON COLUMN blocks.id IS '结构块 ID（bl_ 前缀）';
COMMENT ON COLUMN blocks.version_id IS '所属文档版本 ID';
COMMENT ON COLUMN blocks.doc_id IS '所属文档 ID（冗余，便于按文档清理）';
COMMENT ON COLUMN blocks.parent_id IS '父块 ID（预留层级字段，当前写入均为 NULL）';
COMMENT ON COLUMN blocks.type IS '块类型：paragraph 段落 / table 表格 / code 代码 / formula 公式 / list 列表 / markdown 等';
COMMENT ON COLUMN blocks.page IS '页码（1 起；无页面概念的来源为 NULL）';
COMMENT ON COLUMN blocks.bbox IS 'JSONB 数组 [l,t,r,b]：页面坐标包围盒（解析器坐标系；无几何信息为 NULL）';
COMMENT ON COLUMN blocks.order_index IS '块在文档中的顺序号（0 起）';
COMMENT ON COLUMN blocks.heading_path IS 'JSONB 字符串数组：块所属的标题层级路径';
COMMENT ON COLUMN blocks.text IS '块文本内容';

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  doc_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  page INTEGER,
  bbox JSONB,
  block_type TEXT NOT NULL DEFAULT 'paragraph',
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  is_parent BOOLEAN NOT NULL DEFAULT false,
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  acl_version INTEGER NOT NULL DEFAULT 1,
  dense JSONB NOT NULL DEFAULT '[]'::jsonb,
  sparse JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_dim INTEGER NOT NULL DEFAULT 0,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_chunks_doc_version ON chunks (doc_id, version_id);
CREATE INDEX IF NOT EXISTS ix_chunks_tenant ON chunks (tenant_id);
COMMENT ON TABLE chunks IS '检索单元（chunk）表：切分后的检索与引用单元；向量是派生数据，可由文本重建；父块（is_parent=true）仅作上下文，不参与召回';
COMMENT ON COLUMN chunks.id IS '检索单元 ID（ch_ 前缀）';
COMMENT ON COLUMN chunks.version_id IS '所属文档版本 ID';
COMMENT ON COLUMN chunks.doc_id IS '所属文档 ID';
COMMENT ON COLUMN chunks.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN chunks.seq IS '文档内顺序号（0 起，父块与子块统一编号）';
COMMENT ON COLUMN chunks.heading_path IS 'JSONB 字符串数组：所属标题路径（无标题时为 ["正文"]）';
COMMENT ON COLUMN chunks.page IS '页码（1 起）；内容跨页时为 NULL';
COMMENT ON COLUMN chunks.bbox IS 'JSONB 数组 [l,t,r,b]：合并后的页面包围盒；跨页或缺少几何信息时为 NULL';
COMMENT ON COLUMN chunks.block_type IS '来源块类型：paragraph / table / code / formula / list 等；section 表示章节父块';
COMMENT ON COLUMN chunks.text IS '检索文本：目标上限 512 估算 token，相邻块保留 64 token 重叠；表格/代码/公式整块保留不切分';
COMMENT ON COLUMN chunks.token_count IS '估算 token 数（中文约 1.7 字/token，其他约 4 字符/token）';
COMMENT ON COLUMN chunks.parent_id IS '所属章节父块 ID（父块自身为 NULL）';
COMMENT ON COLUMN chunks.is_parent IS '是否章节父块：true 时仅用于补充上下文，不生成向量、不参与召回';
COMMENT ON COLUMN chunks.acl_principals IS 'JSONB 字符串数组：写入时冗余的文档 ACL 允许列表，检索时与文档 ACL 双重校验';
COMMENT ON COLUMN chunks.acl_version IS '写入时对应的文档 ACL 版本号';
COMMENT ON COLUMN chunks.dense IS 'JSONB 浮点数组：稠密向量（父块为空数组）';
COMMENT ON COLUMN chunks.sparse IS 'JSONB 对象 {词元: 权重}：稀疏向量；hybrid 服务返回的 learned sparse，或本地分词的 1+log(词频)（最多 96 项）';
COMMENT ON COLUMN chunks.embedding_model IS '生成向量的嵌入模型名（父块或未向量化时为空串）';
COMMENT ON COLUMN chunks.embedding_dim IS '稠密向量维度（未向量化时为 0）';
COMMENT ON COLUMN chunks.weight IS '检索权重（默认 1）：用户反馈按 ±0.12 调整，范围 0.5–1.6，用于微调重排得分';
COMMENT ON COLUMN chunks.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'concept',
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_entities_tenant ON entities (tenant_id);
CREATE INDEX IF NOT EXISTS ix_entities_name ON entities (canonical_name);
CREATE INDEX IF NOT EXISTS ix_entities_norm ON entities (normalized_name);
COMMENT ON TABLE entities IS '实体表：事实的主语/宾语节点（知识图谱节点），按归一化名称与别名去重';
COMMENT ON COLUMN entities.id IS '实体 ID（ent_ 前缀）';
COMMENT ON COLUMN entities.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN entities.type IS '实体类型：product 产品 / org 组织 / person 人物 / concept 概念（默认）/ event 事件';
COMMENT ON COLUMN entities.canonical_name IS '规范名称（保留原文写法）';
COMMENT ON COLUMN entities.normalized_name IS '归一化名称：小写并去除空白与 ·•-_/ 等符号，用于去重匹配';
COMMENT ON COLUMN entities.description IS '实体描述（当前创建时为空串）';
COMMENT ON COLUMN entities.status IS '状态：active 有效 / merged 已并入其他实体 / retracted 已撤回';
COMMENT ON COLUMN entities.acl_principals IS 'JSONB 字符串数组：允许读取的主体列表（继承来源文档 ACL）';
COMMENT ON COLUMN entities.created_at IS '创建时间';
COMMENT ON COLUMN entities.updated_at IS '最近更新时间';

CREATE TABLE IF NOT EXISTS entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'extraction'
);
CREATE INDEX IF NOT EXISTS ix_alias_entity ON entity_aliases (entity_id);
CREATE INDEX IF NOT EXISTS ix_alias_norm ON entity_aliases (normalized_alias);
COMMENT ON TABLE entity_aliases IS '实体别名表：同一实体的不同写法，用于实体链接与消歧';
COMMENT ON COLUMN entity_aliases.id IS '别名 ID（ali_ 前缀）';
COMMENT ON COLUMN entity_aliases.entity_id IS '所属实体 ID';
COMMENT ON COLUMN entity_aliases.alias IS '别名原文';
COMMENT ON COLUMN entity_aliases.normalized_alias IS '归一化别名（与 entities.normalized_name 同规则）';
COMMENT ON COLUMN entity_aliases.source IS '别名来源：extraction 抽取自动登记 / semantic-confirmed 模型语义判定确认';

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES entities(id),
  predicate TEXT NOT NULL,
  object_id TEXT REFERENCES entities(id),
  object_literal TEXT,
  valid_from DATE,
  valid_to DATE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  status TEXT NOT NULL DEFAULT 'active',
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  superseded_by TEXT,
  source_doc_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_facts_tenant ON facts (tenant_id);
CREATE INDEX IF NOT EXISTS ix_facts_subject ON facts (subject_id);
CREATE INDEX IF NOT EXISTS ix_facts_status ON facts (status);
COMMENT ON TABLE facts IS '事实表：主谓宾三元组加有效期与置信度（知识图谱的边）；每条生效事实必须有可溯源的原文证据';
COMMENT ON COLUMN facts.id IS '事实 ID（f_ 前缀）';
COMMENT ON COLUMN facts.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN facts.subject_id IS '主语实体 ID';
COMMENT ON COLUMN facts.predicate IS '谓词（简短动词短语）';
COMMENT ON COLUMN facts.object_id IS '宾语实体 ID（实体型宾语；字面量宾语时为 NULL）';
COMMENT ON COLUMN facts.object_literal IS '字面量宾语（数字/日期/文本；实体型宾语时为 NULL）';
COMMENT ON COLUMN facts.valid_from IS '生效日期（含当日；NULL 表示不限）';
COMMENT ON COLUMN facts.valid_to IS '失效日期（不含当日，开区间；NULL 表示至今有效）';
COMMENT ON COLUMN facts.recorded_at IS '事实入库时间';
COMMENT ON COLUMN facts.confidence IS '置信度（0–1，数据库默认 0.6）：常规多来源印证时按证据权重加权融合；审阅合并或模型确认等义归并时取参与事实中的最高值；存疑事实达到 0.7 才进入展示范围，按来源票自动取代旧事实也要求达到 0.7';
COMMENT ON COLUMN facts.status IS '状态：active 生效 / disputed 存疑待审 / superseded 已被新事实取代 / retracted 已撤回（例如失去有效证据、被人工驳回或作为重复事实归并）';
COMMENT ON COLUMN facts.acl_principals IS 'JSONB 字符串数组：允许读取的主体列表';
COMMENT ON COLUMN facts.superseded_by IS '取代本事实的新事实 ID';
COMMENT ON COLUMN facts.source_doc_id IS '首次产生该事实的文档 ID';
COMMENT ON COLUMN facts.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS fact_evidence (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES facts(id),
  chunk_id TEXT,
  doc_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  span JSONB,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_evidence_fact ON fact_evidence (fact_id);
CREATE INDEX IF NOT EXISTS ix_evidence_doc ON fact_evidence (doc_id);
COMMENT ON TABLE fact_evidence IS '事实证据表：事实到原文逐字引文的溯源链接；失去全部有效证据的事实会被自动撤回';
COMMENT ON COLUMN fact_evidence.id IS '证据 ID（ev_ 前缀）';
COMMENT ON COLUMN fact_evidence.fact_id IS '所属事实 ID';
COMMENT ON COLUMN fact_evidence.chunk_id IS '引文所在检索单元 ID（可空）';
COMMENT ON COLUMN fact_evidence.doc_id IS '出处文档 ID';
COMMENT ON COLUMN fact_evidence.quote IS '逐字原文引文（必须能在对应 chunk 文本中找到）';
COMMENT ON COLUMN fact_evidence.span IS 'JSONB 对象 {start,end}：引文在 chunk 文本中的 UTF-16 偏移区间（可空）';
COMMENT ON COLUMN fact_evidence.weight IS '证据权重：初始为来源可信度×解析质量（0.05–1）；用户反馈 ±0.12（0.5–1.6）；30 天未被引用则衰减 ×0.95（下限 0.1）';
COMMENT ON COLUMN fact_evidence.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal',
  kind TEXT NOT NULL DEFAULT 'note',
  text TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  expires_at TIMESTAMPTZ,
  promoted_fact_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_memory_user ON memory_items (tenant_id, user_id);
COMMENT ON TABLE memory_items IS '用户记忆表：个人偏好与备注，仅用于理解用户，不作为事实证据；可经人工审阅晋升为知识事实';
COMMENT ON COLUMN memory_items.id IS '记忆 ID（mem_ 前缀）';
COMMENT ON COLUMN memory_items.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN memory_items.user_id IS '所属用户 ID（记忆按用户隔离）';
COMMENT ON COLUMN memory_items.scope IS '作用域（默认 personal 个人）';
COMMENT ON COLUMN memory_items.kind IS '类型：note 手动备注 / conversation_note 对话中自动记录 / mcp_note MCP 工具备注';
COMMENT ON COLUMN memory_items.text IS '记忆内容';
COMMENT ON COLUMN memory_items.confidence IS '置信度（0–1）：手动创建 0.55，对话自动记录 0.7，MCP 备注 0.5';
COMMENT ON COLUMN memory_items.expires_at IS '过期时间（NULL 表示永不过期；每日反思清理已过期记忆）';
COMMENT ON COLUMN memory_items.promoted_fact_id IS '晋升后关联的事实 ID（记忆晋升审阅通过并抽取成功后回填）';
COMMENT ON COLUMN memory_items.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_conversations_user ON conversations (tenant_id, user_id);
COMMENT ON TABLE conversations IS '研究台会话表：保存用户的多轮问答会话，消息与引用通过关联表保存';
COMMENT ON COLUMN conversations.id IS '会话 ID（conv_ 前缀）';
COMMENT ON COLUMN conversations.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN conversations.user_id IS '所属用户 ID';
COMMENT ON COLUMN conversations.title IS '会话标题（首个问题的前 80 个字符）';
COMMENT ON COLUMN conversations.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'quick',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_messages_conversation ON messages (conversation_id);
COMMENT ON TABLE messages IS '消息表：会话中的用户提问与助手回答';
COMMENT ON COLUMN messages.id IS '消息 ID（msg_ 前缀）';
COMMENT ON COLUMN messages.conversation_id IS '所属会话 ID';
COMMENT ON COLUMN messages.role IS '角色：user 用户提问 / assistant 助手回答';
COMMENT ON COLUMN messages.content IS '消息文本';
COMMENT ON COLUMN messages.mode IS '问答模式：quick 快速 / deep 深度 / graph 图谱 / timeline 时间线 / compare 对比';
COMMENT ON COLUMN messages.latency_ms IS '回答耗时（毫秒；用户消息为 0）';
COMMENT ON COLUMN messages.trace_id IS '关联调用轨迹 ID（traces.id）';
COMMENT ON COLUMN messages.confidence IS '回答置信度（0–1；用户消息为 0，拒答约 0.18）';
COMMENT ON COLUMN messages.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chunk_id TEXT,
  fact_id TEXT,
  doc_id TEXT,
  quote TEXT NOT NULL DEFAULT '',
  page INTEGER,
  rank INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_citations_message ON citations (message_id);
COMMENT ON TABLE citations IS '引用表：助手回答中引用的证据条目，对应回答文本中的 [编号]';
COMMENT ON COLUMN citations.id IS '引用 ID（cit_ 前缀）';
COMMENT ON COLUMN citations.message_id IS '所属助手消息 ID';
COMMENT ON COLUMN citations.chunk_id IS '引用的检索单元 ID';
COMMENT ON COLUMN citations.fact_id IS '关联事实 ID（预留列，当前写入均为 NULL）';
COMMENT ON COLUMN citations.doc_id IS '出处文档 ID';
COMMENT ON COLUMN citations.quote IS '引文：核验定位到的原文句子，缺省为整块文本';
COMMENT ON COLUMN citations.page IS '出处页码（可空）';
COMMENT ON COLUMN citations.rank IS '引用编号（回答中 [n] 的 n，从 1 起）';

CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_review_tenant ON review_queue (tenant_id);
CREATE INDEX IF NOT EXISTS ix_review_status ON review_queue (status);
COMMENT ON TABLE review_queue IS '人工审阅队列表：事实冲突、需人工修正的正文质量问题、记忆晋升等需要人工处理的事项';
COMMENT ON COLUMN review_queue.id IS '审阅项 ID（rev_ 前缀）';
COMMENT ON COLUMN review_queue.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN review_queue.kind IS '类型：fact_conflict 事实冲突 / parse_failure 需人工修正的正文质量问题（历史记录可能包含其他入库异常） / memory_promotion 记忆晋升';
COMMENT ON COLUMN review_queue.title IS '展示标题（如拼好的事实句）';
COMMENT ON COLUMN review_queue.payload IS 'JSONB 业务数据：subject/predicate/new_fact_id/old_fact_ids/quote/doc_id/job_id/memory_id/reason 等，随 kind 不同';
COMMENT ON COLUMN review_queue.status IS '状态：open 待处理 / resolved 已处理';
COMMENT ON COLUMN review_queue.resolution IS 'JSONB 处理结果，action 为人工裁决或系统关闭原因，按动作可附带 note、by 等信息；入库重试成功以 {action: retry_succeeded, document_id} 关闭关联待审项，跳过重复入库以 {action: duplicate_skipped} 关闭，重试发生非正文质量异常以 {action: ingest_error} 关闭历史待审项；模型确认事实完全等义并归并后以 {action: semantic_equivalent, by: system, kept_fact_id} 关闭事实冲突项';
COMMENT ON COLUMN review_queue.created_at IS '创建时间';
COMMENT ON COLUMN review_queue.resolved_at IS '处理完成时间（未处理为 NULL）';

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  input_hash TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jobs_tenant ON jobs (tenant_id);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs (status);
COMMENT ON TABLE jobs IS '异步任务表：入库/事实抽取/回收站/每日维护等后台任务；兼作断点检查点与原始上传文件的存储';
COMMENT ON COLUMN jobs.id IS '任务 ID：普通任务 job_ 前缀；抽取任务固定为 enrich:<文档ID>:<版本号>；每日反思调度为 reflection:<租户ID>:<日期>';
COMMENT ON COLUMN jobs.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN jobs.type IS '任务类型：ingest 入库 / enrich 事实抽取 / trash 移入回收站 / restore 恢复 / purge 彻底删除 / reflection_schedule 每日反思调度';
COMMENT ON COLUMN jobs.status IS '状态：pending 排队 / running 运行中 / awaiting_duplicate 入库检测到重复，等待用户决定 / skipped 用户跳过重复入库 / done 完成 / failed 失败 / stale 已过期（文档换版或入回收站）';
COMMENT ON COLUMN jobs.attempts IS '已尝试次数（入库任务自动重试最多 3 次）';
COMMENT ON COLUMN jobs.error IS '最近一次失败原因（截断至 300 字符；成功时清空）';
COMMENT ON COLUMN jobs.input_hash IS '入库内容的 SHA-256 哈希（目录同步据此跳过未变化文件）';
COMMENT ON COLUMN jobs.payload IS 'JSONB 任务数据：ingest 存 source/user_id/request（含 base64 原始文件及 confirmDuplicates 重复确认开关）/checkpoint（解析断点）/indexed_result（与索引一起提交的结果，供崩溃恢复）/duplicate_decision（continue 继续或 skip 跳过）/result（最终结果）/view（任务界面状态）；enrich 存 document_id/version/user_id/checkpoint（抽取断点）/promotion（记忆晋升）';
COMMENT ON COLUMN jobs.created_at IS '创建时间';
COMMENT ON COLUMN jobs.updated_at IS '最近更新时间：运行中每 30 秒心跳刷新；超过 2 分钟无心跳视为崩溃，任务可被重新抢占';

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_traces_tenant ON traces (tenant_id);
COMMENT ON TABLE traces IS '调用轨迹表：一次功能调用（问答/检索/入库/评测/反馈）的完整记录';
COMMENT ON COLUMN traces.id IS '轨迹 ID（tr_ 前缀）';
COMMENT ON COLUMN traces.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN traces.user_id IS '发起用户 ID';
COMMENT ON COLUMN traces.feature IS '功能名：ask 问答 / search 检索 / ingest 入库 / eval 评测 / feedback 反馈';
COMMENT ON COLUMN traces.question IS '输入问题或标题';
COMMENT ON COLUMN traces.answer IS '输出回答或结果摘要';
COMMENT ON COLUMN traces.status IS '状态：ok 成功 / refused 拒答 / error 失败';
COMMENT ON COLUMN traces.latency_ms IS '总耗时（毫秒）';
COMMENT ON COLUMN traces.meta IS 'JSONB 附加信息：mode/top_score/threshold/refused/evidence_ids/retrieval/confidence/citations/answer_strategy 等';
COMMENT ON COLUMN traces.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_id TEXT,
  stage TEXT NOT NULL,
  input_hash TEXT,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_spans_trace ON trace_spans (trace_id);
COMMENT ON TABLE trace_spans IS '轨迹阶段表：轨迹内各阶段（召回/排序/生成等）的参数、输出与耗时';
COMMENT ON COLUMN trace_spans.id IS '阶段 ID（sp_ 前缀）';
COMMENT ON COLUMN trace_spans.trace_id IS '所属轨迹 ID';
COMMENT ON COLUMN trace_spans.parent_id IS '父阶段 ID（预留层级字段，当前写入均为 NULL）';
COMMENT ON COLUMN trace_spans.stage IS '阶段名：intent / acl.filter / recall.dense / recall.sparse / recall.graph / rank.rrf / rank.rerank / answer.generate / answer.verify / ingest.parse 等';
COMMENT ON COLUMN trace_spans.input_hash IS '阶段输入文本的 SHA-256 前 32 位（未记录输入时为 NULL）';
COMMENT ON COLUMN trace_spans.params IS 'JSONB 阶段参数';
COMMENT ON COLUMN trace_spans.output IS 'JSONB 阶段输出';
COMMENT ON COLUMN trace_spans.latency_ms IS '阶段耗时（毫秒）';
COMMENT ON COLUMN trace_spans.status IS '状态：ok 正常 / error 出错';
COMMENT ON COLUMN trace_spans.occurred_at IS '阶段发生时间';

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  trace_id TEXT,
  span_id TEXT,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  feature TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  price_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_usage_tenant ON usage_ledger (tenant_id);
CREATE INDEX IF NOT EXISTS ix_usage_feature ON usage_ledger (feature);
COMMENT ON TABLE usage_ledger IS '模型用量台账表：每次模型调用的 token 用量与费用明细，按调用时的价格快照计费';
COMMENT ON COLUMN usage_ledger.id IS '用量记录 ID（use_ 前缀）';
COMMENT ON COLUMN usage_ledger.trace_id IS '关联轨迹 ID（可空）';
COMMENT ON COLUMN usage_ledger.span_id IS '关联轨迹阶段 ID（可空）';
COMMENT ON COLUMN usage_ledger.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN usage_ledger.user_id IS '调用用户 ID（可空）';
COMMENT ON COLUMN usage_ledger.feature IS '功能名（同 traces.feature）';
COMMENT ON COLUMN usage_ledger.stage IS '阶段名（如 answer.generate；无阶段时为空串）';
COMMENT ON COLUMN usage_ledger.provider IS '模型供应商';
COMMENT ON COLUMN usage_ledger.model IS '模型名';
COMMENT ON COLUMN usage_ledger.tokens_in IS '输入 token 数';
COMMENT ON COLUMN usage_ledger.tokens_out IS '输出 token 数';
COMMENT ON COLUMN usage_ledger.cached_tokens IS '命中缓存的 token 数（预留，当前恒为 0）';
COMMENT ON COLUMN usage_ledger.price_snapshot IS 'JSONB 计费时价格快照 {input_per_1m,output_per_1m,currency}（来自配置 [prices]）';
COMMENT ON COLUMN usage_ledger.amount IS '费用金额：token 数×单价/100 万，按快照币种计';
COMMENT ON COLUMN usage_ledger.occurred_at IS '调用发生时间';

CREATE TABLE IF NOT EXISTS model_prices (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '1M_tokens',
  input_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
  output_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  effective_from DATE NOT NULL,
  effective_to DATE
);
COMMENT ON TABLE model_prices IS '模型价格登记表：按生效日期版本化的模型单价；初始化时从配置 [prices] 播种，运行时计费以配置为准';
COMMENT ON COLUMN model_prices.id IS '价格记录 ID（price_ 前缀）';
COMMENT ON COLUMN model_prices.provider IS '模型供应商';
COMMENT ON COLUMN model_prices.model IS '模型名';
COMMENT ON COLUMN model_prices.unit IS '计价单位（默认 1M_tokens，即每百万 token）';
COMMENT ON COLUMN model_prices.input_per_1m IS '每百万输入 token 单价';
COMMENT ON COLUMN model_prices.output_per_1m IS '每百万输出 token 单价';
COMMENT ON COLUMN model_prices.currency IS '币种（默认 CNY）';
COMMENT ON COLUMN model_prices.effective_from IS '生效日期（含当日）';
COMMENT ON COLUMN model_prices.effective_to IS '失效日期（NULL 表示长期有效）';

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'tenant',
  period TEXT NOT NULL DEFAULT 'month',
  limit_amount DOUBLE PRECISION NOT NULL DEFAULT 100,
  used_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  alert_at DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_budgets_tenant ON budgets (tenant_id);
COMMENT ON TABLE budgets IS '预算表：租户级模型费用预算与告警阈值';
COMMENT ON COLUMN budgets.id IS '预算 ID（bud_ 前缀）';
COMMENT ON COLUMN budgets.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN budgets.scope IS '预算范围（当前使用 tenant 租户级）';
COMMENT ON COLUMN budgets.period IS '预算周期标识（默认 month 月度；当前实现不自动按周期清零）';
COMMENT ON COLUMN budgets.limit_amount IS '预算上限金额（默认 100）';
COMMENT ON COLUMN budgets.used_amount IS '已用金额：每次模型调用后按用量累加';
COMMENT ON COLUMN budgets.alert_at IS '告警阈值比例（0–1，默认 0.8，即用到预算 80% 时告警）';
COMMENT ON COLUMN budgets.updated_at IS '最近更新时间';

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_feedback_target ON feedback (target_id);
COMMENT ON TABLE feedback IS '用户反馈表：对回答或检索单元的赞/踩，驱动检索权重与证据权重调整';
COMMENT ON COLUMN feedback.id IS '反馈 ID（fb_ 前缀）';
COMMENT ON COLUMN feedback.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN feedback.user_id IS '反馈用户 ID';
COMMENT ON COLUMN feedback.target_type IS '反馈对象类型：message 助手回答 / chunk 检索单元';
COMMENT ON COLUMN feedback.target_id IS '反馈对象 ID';
COMMENT ON COLUMN feedback.value IS '反馈值：1 赞 / -1 踩；同一用户对同一对象只保留最新一条（改票更新原记录）';
COMMENT ON COLUMN feedback.comment IS '反馈备注（可空）';
COMMENT ON COLUMN feedback.created_at IS '创建时间';

-- 原生对话反馈：接管 DSH“好的回答 / 有问题的回答”按钮后记录在本系统，
-- 不发送上游；与 feedback 表分开，不参与检索/证据权重调整。
CREATE TABLE IF NOT EXISTS chat_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  comment TEXT,
  context TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, session_id, message_id)
);
CREATE INDEX IF NOT EXISTS ix_chat_feedback_tenant ON chat_feedback (tenant_id, created_at);
COMMENT ON TABLE chat_feedback IS '原生对话反馈表：AI 对话页“好的回答/有问题的回答”按钮的接管记录，仅存本系统，不发送上游，也不影响检索权重';
COMMENT ON COLUMN chat_feedback.id IS '反馈 ID（cf_ 前缀）';
COMMENT ON COLUMN chat_feedback.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN chat_feedback.user_id IS '调用反馈接口时认证的用户 ID';
COMMENT ON COLUMN chat_feedback.session_id IS 'DSH 原生会话 ID（最多 200 个 UTF-16 代码单元）';
COMMENT ON COLUMN chat_feedback.message_id IS 'DSH 原生助手消息 ID（最多 200 个 UTF-16 代码单元）；同一租户内同一用户对同一会话和消息改票时更新原记录';
COMMENT ON COLUMN chat_feedback.value IS '反馈值：1 好的回答 / -1 有问题的回答';
COMMENT ON COLUMN chat_feedback.comment IS '用户填写的反馈说明（可空，最多 2000 个 UTF-16 代码单元）';
COMMENT ON COLUMN chat_feedback.context IS '反馈时的问题与回答摘录（可空，最多 4000 个 UTF-16 代码单元）；改票时未提交摘录则保留原值';
COMMENT ON COLUMN chat_feedback.created_at IS '首次提交时间';
COMMENT ON COLUMN chat_feedback.updated_at IS '最近一次改票/更新时间';

CREATE TABLE IF NOT EXISTS gaps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  question TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  suggested_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gaps_tenant ON gaps (tenant_id);
COMMENT ON TABLE gaps IS '知识缺口表：拒答问题登记，提示需要补充的资料；相似问题会被聚类合并';
COMMENT ON COLUMN gaps.id IS '缺口 ID（gap_ 前缀）';
COMMENT ON COLUMN gaps.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN gaps.question IS '归一化后的问题文本（小写、压缩空白）';
COMMENT ON COLUMN gaps.count IS '累计出现次数（相似缺口聚类时合并计数）';
COMMENT ON COLUMN gaps.status IS '状态：open 待补充 / resolved 已解决 / clustered 已并入相似缺口';
COMMENT ON COLUMN gaps.suggested_sources IS 'JSONB 字符串数组：补库建议';
COMMENT ON COLUMN gaps.created_at IS '创建时间';
COMMENT ON COLUMN gaps.updated_at IS '最近更新时间';

CREATE TABLE IF NOT EXISTS replay_runs (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  target_stage TEXT NOT NULL DEFAULT 'retrieve',
  overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  diff JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'done',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE replay_runs IS '检索回放表：对历史轨迹以新参数重跑检索并记录证据差异';
COMMENT ON COLUMN replay_runs.id IS '回放 ID（rep_ 前缀）';
COMMENT ON COLUMN replay_runs.trace_id IS '被回放的原轨迹 ID';
COMMENT ON COLUMN replay_runs.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN replay_runs.target_stage IS '回放目标阶段（当前仅支持 retrieve 检索）';
COMMENT ON COLUMN replay_runs.overrides IS 'JSONB 回放参数覆盖（top_k/as_of 等）';
COMMENT ON COLUMN replay_runs.diff IS 'JSONB 结果差异 {previous,current,added,removed,top_score}：前后命中的 chunk ID 列表及变化';
COMMENT ON COLUMN replay_runs.status IS '回放状态（当前完成即写入 done）';
COMMENT ON COLUMN replay_runs.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  question TEXT NOT NULL,
  expected_docs JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  should_refuse BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'golden',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE eval_cases IS '评测用例表：黄金集问题与预期结果';
COMMENT ON COLUMN eval_cases.id IS '用例 ID（ec_ 前缀）';
COMMENT ON COLUMN eval_cases.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN eval_cases.question IS '评测问题';
COMMENT ON COLUMN eval_cases.expected_docs IS 'JSONB 字符串数组：预期命中的文档 ID 或标题';
COMMENT ON COLUMN eval_cases.expected_keywords IS 'JSONB 字符串数组：回答应包含的关键词';
COMMENT ON COLUMN eval_cases.should_refuse IS '是否应当拒答';
COMMENT ON COLUMN eval_cases.source IS '用例来源：golden 黄金集 / imported 批量导入 / golden-reviewed 人工审定 / failure-candidate:<轨迹ID> 线上拒答自动候选（不参与正式评测）';
COMMENT ON COLUMN eval_cases.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE eval_runs IS '评测运行表：一次评测的汇总指标与逐用例结果';
COMMENT ON COLUMN eval_runs.id IS '评测运行 ID（er_ 前缀）';
COMMENT ON COLUMN eval_runs.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN eval_runs.metrics IS 'JSONB 评测指标：mode/recall_at_10/context_precision/citation_accuracy/refusal_accuracy/pass_rate/p95_latency_ms 等，results 为逐用例明细';
COMMENT ON COLUMN eval_runs.model_version IS '评测使用的主模型名';
COMMENT ON COLUMN eval_runs.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS reflection_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE reflection_runs IS '反思运行表：每日知识维护（实体合并/冲突检测/过期记忆清理/摘要重建/证据衰减）的结果记录';
COMMENT ON COLUMN reflection_runs.id IS '反思运行 ID（ref_ 前缀）';
COMMENT ON COLUMN reflection_runs.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN reflection_runs.summary IS 'JSONB 运行摘要：entities_scanned/merged_entities/facts_scanned/conflicts_marked/equivalent_merges/expired_memories/entity_summaries/community_summaries/orphaned_facts/decayed_evidence/clustered_gaps 为计数，elapsed_ms 为耗时（毫秒）';
COMMENT ON COLUMN reflection_runs.created_at IS '创建时间';

CREATE TABLE IF NOT EXISTS knowledge_summaries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  text TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_knowledge_summaries_tenant ON knowledge_summaries(tenant_id);
COMMENT ON TABLE knowledge_summaries IS '知识摘要缓存表：由生效事实抽取式拼接的实体/社区摘要（派生数据，事实或文档变化时整体重建）';
COMMENT ON COLUMN knowledge_summaries.id IS '摘要 ID（sum_ 前缀）';
COMMENT ON COLUMN knowledge_summaries.tenant_id IS '所属租户 ID';
COMMENT ON COLUMN knowledge_summaries.kind IS '摘要类型：entity 单实体摘要 / community 连通社区摘要';
COMMENT ON COLUMN knowledge_summaries.subject_id IS '实体摘要的主语实体 ID（community 摘要为 NULL）';
COMMENT ON COLUMN knowledge_summaries.acl_principals IS 'JSONB 字符串数组：摘要所属 ACL 分区（仅同一授权分区的事实可合并摘要）';
COMMENT ON COLUMN knowledge_summaries.text IS '摘要正文：事实句与原文引文拼接（抽取式，非模型生成）';
COMMENT ON COLUMN knowledge_summaries.evidence_ids IS 'JSONB 字符串数组：支撑该摘要的检索单元 ID 列表';
COMMENT ON COLUMN knowledge_summaries.input_hash IS '摘要正文的 SHA-256 内容指纹';
COMMENT ON COLUMN knowledge_summaries.updated_at IS '最近重建时间';

ALTER TABLE fact_evidence ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();
COMMENT ON COLUMN fact_evidence.last_used_at IS '证据最近使用时间（初始为写入时间，关联检索单元被回答引用时刷新，用于证据衰减判断）';
ALTER TABLE fact_evidence ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ;
COMMENT ON COLUMN fact_evidence.last_decay_at IS '最近一次权重衰减时间（NULL 表示尚未衰减）';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS enrichment_error TEXT;
COMMENT ON COLUMN documents.enrichment_error IS '最近一次事实抽取失败的错误信息（截断至 300 字符；成功时清空）';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_trust DOUBLE PRECISION NOT NULL DEFAULT 0.5;
COMMENT ON COLUMN documents.source_trust IS '来源可信度（0–1，默认 0.5）：可人工编辑，与解析质量相乘并限制在 0.05–1 后作为初始证据权重';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_core BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN documents.is_core IS '是否标记为核心文档（默认 false）；设为 true 可触发事实抽取，也满足历史延迟抽取文档的补抽条件';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
COMMENT ON COLUMN documents.deleted_at IS '移入回收站时间（恢复时清空）';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_by TEXT;
COMMENT ON COLUMN documents.deleted_by IS '移入回收站的操作用户 ID（恢复时清空）';
CREATE INDEX IF NOT EXISTS ix_documents_trash ON documents (tenant_id, status, deleted_at);
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN memory_items.tags IS 'JSONB 字符串数组：记忆标签（默认空数组）';
-- 会话归档：超过配置天数没有新消息的会话由每日维护标记 archived_at；
-- 消息与引用完整保留，继续提问会自动恢复。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
COMMENT ON COLUMN conversations.archived_at IS '归档时间（NULL 表示在最近列表）；可手动归档或恢复。定期维护按最后消息时间判断是否超过配置天数，无消息时按创建时间计算，配置 0 天关闭自动归档。继续提问自动恢复（置 NULL）';
CREATE INDEX IF NOT EXISTS ix_conversations_archive ON conversations (tenant_id, user_id, archived_at);
