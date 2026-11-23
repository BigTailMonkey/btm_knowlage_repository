# btm_knowlage_repository 高强度测试报告

## 2026-11-23 修复复验更新

用户要求修复失败项，并明确继续后置 HI-07（跨用户反馈）、HI-08（跨用户轨迹）、HI-19（未认证 /meta）。没有修改这三个接口的访问策略。

- 修复前原样重跑：实际 **29 项，10 通过、19 失败**，不是原报告中写的 30 项。
- 修复后完整重跑：**26 通过、3 失败**；剩余失败恰为上述用户暂缓的权限项，完整日志仍保留失败。
- 限定本轮非暂缓范围单独验收：**26/26 通过**。
- 常规回归：**279/279**，新增 7 项正反例；最终回答/MCP/输入专项另为 48/48。
- 离线固定题集：50/50；真实库同一 10 题完整重跑最终 10/10，引用逐字核对无错误。真实库首轮 9/10，失败为模型追加无关年份对比并错引；收紧回答范围后完整重跑通过，没有拼接成功单题。
- 运行中的本机服务已加载修复，9 项实际 API 边界检查通过，健康状态为 ok。typecheck/build/diff 检查通过。

本轮修复：请求体/字符串/NUL 校验、MCP 协议及预算校验、咨询历史、反馈目标枚举、缺口长度、事实展示过滤、历史版本关联事实读取、拒答前缀误判、重复引用置信度、中文时间切片日期；检索、结构化查询、时间切片工具、沿革详情和列表徽标共用可读有效代判断，跨回收站中间代的后续也按同一规则处理。保留缺引用、错误数字、事件日期与错误单位的拒绝检查。

测试同步校正：HI-10 改为断言空 ACL 被 400 拒绝且不写文档；HI-11 补齐版本和切块夹具，并交叉检查检索与徽标；HI-12 按实际返回的 rows/total 核对指定事实。HI-16 原来使用不存在的 fact_id 字段造成假通过，现改为 id，并验证既有契约：默认时间线保留历史记录，显式当前日期切片排除已过期事实。

脱敏汇总见 [验收 JSON](../../docs/validation/high-intensity-fix-2026-11-23.json)。原始日志在 data/audit-2026-11-23/high-intensity-*.log 或 .tap；完整 29 项结果为 high-intensity-fix-final.tap，非暂缓范围结果为 high-intensity-nondeferred.tap。以下保留 11 月 18 日原始审计记录，不能将旧问题表当作当前状态。

---

测试日期：2026-11-18　环境：macOS / Node v22.22.2 / PostgreSQL（Docker knowweave-pg）/ Chrome 无头
测试对象：KnoWeave 知织（Node 主服务 + Python 解析边车 + Web 前端）
测试性质：只读验证 + 隔离临时数据库探针，未改动业务知识库，未调用需外发的真实模型评测。

---

## 一、测试覆盖与基线

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm test`（Node 回归） | 257/257 通过 |
| `npm run test:sidecar` | 12/12 通过 |
| `npm run eval:offline` | 50/50，Recall@10=1，上下文精度=1，p95=18ms（词频基线，非真实模型） |
| `npm run test:browser` | 全项通过，JS 异常为空 |
| `tests/audit/bugs.test.ts`（历史审计探针） | 26 通过 / **4 失败**（G1/G2/G3/H2 仍开放） |
| 本次新增探针（3 个文件，共 30 例） | **23 例失败 = 23 个新实证 BUG**，7 例通过（对照组） |

新增探针文件（断言“正确行为”，失败即实证 BUG，不在 `npm test` glob 内）：
- `tests/audit/high-intensity.test.ts`（14 例，14 失败）
- `tests/audit/high-intensity-2.test.ts`（9 例，7 失败）
- `tests/audit/high-intensity-3.test.ts`（6 例，2 失败）

未执行：`npm run eval:live`（会向配置的火山引擎真实发送问题并产生 API 费用；历史授权针对特定审计轮次，本轮未获授权）。

---

## 二、知识库准确率问题（10 项）

| 编号 | 输入与复现步骤 | 预期 | 实际 | 严重程度 | 影响范围 | 疑似原因 |
|---|---|---|---|---|---|---|
| KB-01 | `validateGrounding('截至2024年6月1日时间切片，补贴为89元[1]。', [{text:'2024年…89元。'}], {asOf:'2024-06-01'})`（HI-13） | 可信 `as_of` 的中文等价写法同样豁免原文日期 | 拒答：`所引原文中未找到数字或单位「2024-06-01」` | 中 | 所有带 `as_of` 的历史问答，模型措辞稍变即误拒 | `grounding.ts:157` 豁免发生在归一前的字符串替换，`numericClaims` 归一后数字核对不认中文日期 |
| KB-02 | 文档含 v1/v2；v1 上事实 `valid_to=2024-01-01`；调用 `kb_get_document(version_id=v1)`（HI-15） | 返回该历史版本当时成立的事实 | `facts=[]`，事实被“今天”的有效期过滤 | 高 | 原生只读工具历史版本核对、历史问答 | `mcp.ts:249` 对历史版本仍用 `factIsEffective(fact, null)` |
| KB-03 | `pub-old`(public) → `priv-new`(user:u_linker) 沿革；以普通用户调 `kb_query_facts`（HI-12） | 后续不可读时，可读前序的事实仍可见（与 D2 修复一致） | `total=0`，前序事实整体消失 | 高 | MCP `kb_query_facts`、`kb_graph`、原生对话结构化统计 | `knowledge-query.ts:123-131` 沿革排除只查 `successor.status='active'`，不查 ACL；D2 修复未同步到该文件 |
| KB-04 | A→B→C 沿革，B 进回收站；查看 `continuationView(A)`（HI-11） | 仅 C `in_force=true` | `in_force` 为 `['chain-a','chain-c']`，两代同时显示生效 | 中 | 文档详情沿革视图、列表徽标；与检索结果矛盾 | `continuation.ts:162` 只看直接后继状态，未复用递归跨代逻辑 |
| KB-05 | 模型输出「现有信息没有提到例外情况，但标准明确为89元[1]。」，证据逐字一致（HI-17） | 正常回答 | `failure.stage=model_refusal`，答案替换为“生成模型判断现有片段不足以回答” | 中 | 对比/辨析类回答；先否定再给结论的合法措辞 | `answering.ts:14,364` 仅靠句首正则判定拒答，未结合有效引用 |
| KB-06 | 同一合法引用 `[1]` 重复 3 次 vs 1 次（HI-27） | 置信度不应因合法重复引用下降 | 0.784 vs 0.917，明显下降 | 低 | 回答置信度展示与阈值过滤 | `answering.ts:121-123` 分子用去重 `Set`、分母用未去重数组 |
| KB-07 | 比对 `schema.sql:87` 注释与 `sync-directory.ts:44` | 注释应写 `directory:<source>/<key>` | 注释写“目录同步为 `file://` URI”，全仓库无 `file://` 写入 | 中 | 开发者对字段语义的理解，违反 AGENTS.md | 身份方案改为 `directory:` 后注释未同步 |
| KB-08 | `config.example.toml:45` 与 `config.ts:101` | embedding 兜底地址与示例一致 | 示例 `api/coding/v3`，代码兜底 `api/v3` | 低 | 按示例配置的用户 | 两处 URL 分别维护 |
| KB-09 | `schema.sql:274` 注释称 `entities.type` 为 5 种枚举 | 注释反映实际约束 | 代码只 `String().slice(0,24)`，接受模型任意输出 | 低 | 实体类型统计口径 | 注释按典型输出归纳，未反映无白名单 |
| KB-10 | `README.md:9` vs `package.json:8` / CI | Node 版本一致 | README 24.9+，engines/CI 为 ≥24 | 低 | 部署环境判断 | 文档未与工程约束对齐 |

> 已核验为准确：31 张表 / 296 字段注释全覆盖；数值阈值、RRF、退避序列、实体合并阈值、心跳时序、接口清单、8 份 validation 报告指标与 fixture 均自洽。

---

## 三、功能 BUG（16 项）

### 3.1 本轮新发现（12 项）

| 编号 | 输入与复现步骤 | 预期 | 实际 | 严重程度 | 影响范围 | 疑似原因 |
|---|---|---|---|---|---|---|
| BUG-01 | `POST /api/v1/mcp {"method":123}`（HI-01） | JSON-RPC `-32600` / 400 | **500** `{"detail":"payload.method.startsWith is not a function"}` | 高 | 所有 MCP 客户端；可稳定制造 500 | `mcp.ts:156` 无运行时类型校验且在 try 之外 |
| BUG-02 | `POST /api/v1/search {"query":{"text":"报销"}}`（HI-02） | 400 | **500** `(payload.query ?? '').trim is not a function` | 高 | 核心检索端点 | `ask.ts:24` TS 断言不产生运行时校验 |
| BUG-03 | `POST /api/v1/ask {"question":123}`（HI-03） | 400 | **500** `(input.question ?? '').trim is not a function` | 高 | 核心问答端点 | `answering.ts:241` 同上 |
| BUG-04 | `GET /api/v1/costs/summary?days=abc`（HI-04） | 400 | **500** `invalid input syntax for type interval: "NaN days"` | 中 | 成本统计 | `ops.ts:230` 未复用 `integerParam()` |
| BUG-05 | `POST /api/v1/review/rev_hi/consult {"history":"abc"}`（HI-06） | 400 | **500** `history.map is not a function` | 中 | 审阅辅助 | `learn.ts:32,112` 无 `Array.isArray` |
| BUG-06 | `POST /api/v1/search {"query":"\u0000\u0000"}`（HI-25） | 400 或正常 | **500** `invalid byte sequence for encoding "UTF8": 0x00` | 中 | 检索/问答写入轨迹时崩溃 | 输入未过滤 NUL，写入 PG 文本列报错 |
| BUG-07 | MCP `kb_search` 传 `top_k=0`（HI-14） | 参数校验 `-32602` | 静默按默认值 8 执行，返回成功 | 低 | 调用方误以为参数生效 | `retrieval.ts:295` `Number(0)||8` |
| BUG-08 | 摄入 `acl:"tenant:public"`（字符串）（HI-18） | API/任务返回 400 | 异常 `(acl ?? []).map is not a function`，后台任务永久失败 | 中 | 所有文本/URL 摄入 | `ingestion.ts:24` 无运行时类型校验 |
| BUG-09 | `POST /api/v1/memory {"text":{"a":1}}`（HI-20） | 400 | 200，对象被序列化污染 `memory_items` | 低 | 个人记忆数据质量 | `learn.ts:397` 仅真值检查 |
| BUG-10 | MCP `kb_report_gap` 传 25 万字符问题（HI-21） | 400 或截断至 500 | 200，原文长度写入 gaps 表 | 低 | gaps 表膨胀、列表展示成本 | `mcp.ts:317` 无 `optionalText` 复用 |
| BUG-11 | `POST /api/v1/feedback {"target_type":"anything",...}`（HI-22） | 400 | 200，写入非法类型反馈 | 低 | feedback 表污染、权重逻辑空转 | `ask.ts:205-256` 未枚举校验 |
| BUG-12 | `GET /api/v1/facts?status=retracted`（HI-09） | 400 或叠加展示策略 | 200，返回已撤回事实（含 0.9 置信度） | 中 | 事实列表暴露不应展示的数据 | `learn.ts:203-206` `if/else` 二选一，未 AND 叠加 `DISPLAYABLE_FACT` |

### 3.2 历史审计仍开放（4 项，`tests/audit/bugs.test.ts` 复验失败）

| 编号 | 问题 | 严重程度 | 影响范围 | 状态 |
|---|---|---|---|---|
| G1 | viewer 可裁决事实审阅（`POST /review/:id/resolve` 缺 `requireEditor`） | 高 | 权限越界，低权限角色可改知识库 | 11-18 修复记录中明确暂缓 |
| G2 | `GET /review` 与咨询路径向无权用户泄露私有文档 `quote` 原文 | 高 | 私有原文泄露 | 同上 |
| G3 | 记忆晋升提交者可自行批准，生成 `acl:['tenant:public']` 文档 | 高 | 晋升审批形同虚设 | 同上 |
| H2 | `GET /gaps` 无用户过滤，viewer 可见他人拒答问题（含身份证号） | 高 | 敏感问题跨用户泄露 | 同上 |

---

## 四、其他稳定性 / 健壮性问题（5 项）

| 编号 | 输入与复现步骤 | 预期 | 实际 | 严重程度 | 影响范围 | 疑似原因 |
|---|---|---|---|---|---|---|
| STAB-01 | 触发任一 500 后查看响应体（HI-05） | 泛化“内部错误”，详情只写日志 | 回显 PG 原始消息 `invalid input syntax for type interval: "NaN days"` | 中 | 全 API；泄露表名/SQL/上游 URL | `server.ts:57-61` 未按 4xx/5xx 分流 |
| STAB-02 | owner 提交含敏感 `comment` 的反馈，viewer 调 `GET /chat-feedback`（HI-07） | 仅返回本人反馈或管理员权限 | viewer 读到 owner 的 `comment`/`context` 全文 | 中 | 同租户跨用户隐私 | `chat-feedback.ts:73-75` 仅按 `tenant_id` 过滤 |
| STAB-03 | owner 写入轨迹，viewer 调 `GET /api/v1/traces`（HI-08） | 403 或仅本人轨迹 | 200，返回他人 `question`/`answer`/`user_id`/`meta` | 中 | 同租户跨用户问答泄露 | `ops.ts:93` 只有 `authenticate`，漏 `requireAdmin`/`user_id` |
| STAB-04 | `ingestParsed(..., {acl: []})`（HI-10） | 空 ACL = 默认拒绝或 400 | 文档 ACL 被改为 `["tenant:public"]`，全员可见 | **高（安全）** | 所有文本/URL/目录同步摄入；机密文档被静默公开 | `ingestion.ts:25` `cleaned.length ? cleaned : ['tenant:public']` |
| STAB-05 | 未认证 `GET /api/v1/meta`（HI-19） | 401 或不暴露内部配置 | 200，暴露 model / embedding_model / 阈值 / 租户 ID | 低 | 技术栈测绘 | `routes/index.ts:37` 无鉴权 |

---

## 五、优先级排序

**P0 — 立即修复（安全 / 核心可用性）**
1. G1 viewer 可裁决审阅
2. G2 审阅原文越权泄露
3. G3 记忆晋升自审自批
4. H2 缺口列表跨用户泄露
5. STAB-04 空 ACL fail-open 为全员可见
6. BUG-02 / BUG-03 核心 `/search`、`/ask` 类型混淆 500

**P1 — 本迭代修复**
7. BUG-01 MCP method 500（协议边界）
8. BUG-05 审阅咨询 500
9. BUG-04 成本统计 500 + STAB-01 错误信息脱敏
10. BUG-12 事实展示策略旁路
11. KB-03 / KB-02 沿革 ACL 与历史版本事实（检索准确率）
12. STAB-02 / STAB-03 跨用户反馈与轨迹读取
13. BUG-06 NUL 字节 500
14. KB-05 拒答前缀误判

**P2 — 下迭代**
15. KB-04 沿革视图徽标、KB-01 中文 `as_of` 日期
16. KB-07 schema 注释、BUG-08 ACL 类型、BUG-09/10/11 输入校验
17. BUG-07 `top_k=0`、KB-06 置信度去重、STAB-05 `/meta` 鉴权

**P3 — 文档同步**
18. KB-08 / KB-09 / KB-10

---

## 六、改进建议

1. **在路由边界统一做运行时输入校验**：用 Fastify JSON Schema 或复用 `integerParam()` 模式，覆盖 `query/question/method/history/acl/text/target_type/top_k`，禁止 `.trim()`/`.map()` 直接作用于未校验值；NUL 等控制字符在入口过滤。
2. **5xx 与 4xx 错误响应分流**：5xx 一律返回泛化文案，原始错误只写日志；MCP/SSE 的 catch 分支同样脱敏。
3. **沿革规则单一事实源**：`retrieval.ts`、`knowledge-query.ts`、`continuation.ts`、`mcp.ts` 中的沿革排除谓词抽成公共函数，统一处理“跨已回收中间代 + 后继 ACL + 历史版本”，避免 11-18 修复只落一处。
4. **完成暂缓的四项安全修复**：审阅角色校验、审阅 payload/咨询路径 ACL、记忆晋升提交者与审批者分离、缺口按 `user_id` 隔离；这是当前最高风险面。
5. **ACL 默认拒绝贯穿写入路径**：显式空 ACL 不再回退 `tenant:public`；缺失 ACL 由调用方显式传默认值。
6. **拒答判定结合证据**：`REFUSAL_PREFIX` 仅在无有效引用或无生成文本时生效，避免合法「先否定后立论」被吞。
7. **置信度口径统一**：引用覆盖率分子分母均按引用编号集合计算。
8. **文档与 schema 同步机制**：把注释一致性检查纳入 CI（比对 `COMMENT ON` 与代码枚举/前缀），并在 `README`/`config.example` 中统一 Node 版本与端点地址。
9. **回归防线**：将本轮 23 个探针（修复后）纳入 `npm test`，确保同类问题不再回归；`eval:live` 需单独授权后再跑，且题集应补充未知问题拒答与业务问答，避免 50 题全是代码摘录导致准确率虚高。

---

## 七、已知限制

- 未验证真实模型问答准确率（`eval:live` 未授权执行）；离线 50/50 是词频检索基线。
- p95=8183ms（历史 live 记录）仍未达 3000ms 目标。
- 浏览器/Sidecar 冒烟为契约替身，不等同于真实 Docling/MinerU/Whisper/BGE 权重验收。
- 本轮并发压测（100 次检索 / 30 次问答）未出现 5xx，但样本量有限，不代表生产容量结论。
