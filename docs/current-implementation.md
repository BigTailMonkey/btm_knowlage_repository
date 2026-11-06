# 当前知识库与问答实现

更新：2026-11-06。本文记录当前 Node 主服务的可用行为，设计方案的长期目标保持不变。权限、计费、预算按本轮明确范围暂缓，其原始审计发现仍有效。

## 本轮已修复

| 能力 | 当前行为 |
|---|---|
| 知识库对话 | 默认聊天与研究台均调用 Node `/ask`，共用检索、引用、历史消息和个人记忆。独立运行时调试界面不替代知识库聊天。 |
| 文档更新 | 同租户同名上传使用稳定来源，内容变化增加同一文档的版本；相同内容跳过；回退到历史内容会生成新版本。不同文件来源即使内容相同也保留独立身份。兼容旧 hash URI，不自动合并历史重复文档。 |
| 显式文档更新 | 上传 multipart、文本/URL JSON 可传 `doc_id`，用于改名文件或粘贴文本的明确更新。文档详情提供更新内容入口。 |
| 入库一致性 | 向量生成成功后事务提交版本、结构块和检索单元；失败保留旧版本。嵌入式数据库串行调度事务，防止不同来源并发提交相互交错。 |
| 切块 | 正文按估算 token 预算切分并有限重叠；表格、代码、公式原子保存。跨页子块保留各自页码和坐标，结构块不再混入邻接正文。 |
| 引用定位 | 保存相对于 `document_versions.text` 的 UTF-16 字符区间；引用可打开对应版本的规范化原文并高亮，不会默认跳到更新后的版本。缺失的 PDF 几何 bbox 仍为 null，不声称具备原 PDF 版面高亮。 |
| 引用核对 | 检查每句引用编号、数字/单位、文字支持与明显否定方向；缺失或无法核对时回退为带真实引用的原文摘录，不自动给无引用生成文本补依据。原文摘录同样持久化引用。 |
| 查询模式 | quick 单轮；deep 证据不足时最多三轮补检索；compare 并行召回并输出带引用的对比表；graph 有界多跳，默认两跳、最多三跳；timeline 使用历史版本与有效事实。 |
| 历史检索 | `as_of=YYYY-MM-DD` 选择截至该日工作区已存的最新文档版本，并过滤事实有效期。它不是来源内容实际生效日期的推断，也不是完整双时间数据库；无法查询从未存入的历史版本。 |
| 事实校验 | 完整 quote 必须匹配当前原文，主体/宾语具有字面支持，保存证据区间。无可验证出处的候选被拒绝；全文分批抽取，版本变化时丢弃旧结果。 |
| 审阅与合并 | 新单源或低置信事实等待审阅；独立文档一致佐证可生效。重复抽取不重复加证据；非连续有效期分别保留。删除来源后不能通过审阅复活失效事实。 |
| 对话记忆 | “记住这个：…”写入个人记忆并去重；后续检索只使用未过期的相关记忆，记忆不能作为知识事实引用。 |
| 引用反馈 | 页面消息反馈更新该回答实际引用片段与事实证据的权重，负反馈降低检索分；重复同一投票不反复累计，改变投票按差值调整。 |
| MCP | search 支持过滤；get_document 返回完整版本文本及全部检索块；timeline 支持 entity_id/as_of，并兼容 name。 |

引用规则是保守的确定性检查，无法证明所有改写的语义蕴含关系，可能把正确改写回退为原文。当前不宣称已通过真实文档黄金集的准确率指标。

## 当前接口

所有知识库 API 位于 `/api/v1`，继续沿用已有 Bearer 身份机制。

```text
POST /documents/upload       multipart: file, title?, acl?, doc_id?
POST /documents/text         JSON: text, title?, acl?, doc_id?
POST /documents/url          JSON: url, title?, acl?, doc_id?
GET  /documents/{id}         可选 ?version_id=...；返回 source、chunks、versions 等
POST /documents/{id}/reprocess  重新抽取事实（当前不是整条解析流水线重试）
POST /search                 query, top_k?, doc_ids?, source_type?, as_of?
POST /ask                    question, mode?, top_k?, doc_ids?, as_of?, conversation_id?
POST /feedback               target_type=message|chunk, target_id, value=1|-1, comment?
POST /mcp                    JSON-RPC tools/list、tools/call
```

`source.text` 是解析后的规范化原文；`chunks[].spans` 的 start/end 为其 UTF-16 偏移（末尾不含），coordinate_system 为 `normalized-text-utf16`。旧文档没有区间元数据时，页面按引用原文匹配定位。历史引用通过 chunk 对应的版本读取，不把旧引用定位到当前文档。

MCP 工具：`kb_search(query, filters?, top_k?)`、`kb_ask(question, mode?, as_of?)`、`kb_get_document(doc_id)`、`kb_entity_timeline(entity_id?, name?, as_of?)`、`kb_add_note(text)`、`kb_report_gap(question)`。tags 尚未成为记忆字段。

## 保留的选型与后续目标

当前是 PGlite / PostgreSQL + JSONB 向量、云端稠密 Embedding、字词频稀疏召回、RRF 与规则重排，前端为 HTML/CSS/JavaScript。SDK 以子进程运行，业务消息落数据库；不宣称全部运行时状态均在 PostgreSQL 或已经实现真实流式分片。

PDF / DOCX 使用 pypdf / python-docx；Docling、MinerU、OCR / ASR、完整扫描件/公式版面识别仍待实现。向量模型替换与语义重排需要单独验证，不能把规则重排视为 Cross-Encoder。

持久摄入队列、重启后恢复/单步重试、本地目录与外部连接器、语义实体对齐、来源可信度裁决、分级富化、社区摘要和完整反思维护仍在路线图。已有图谱模式为有界关系遍历，不包含社区摘要。

现有评测页面仍以检索测试为主；Node 回归覆盖本轮核心行为，但不替代真实文档黄金集、答案语义评测、性能和真实模型集成验收。回放、冷热归档、权限、计费和预算也没有在本轮扩展为设计中的完整系统。
