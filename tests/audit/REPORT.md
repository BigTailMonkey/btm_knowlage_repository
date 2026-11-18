# KnoWeave 知识库对抗性审计报告（2026-11-16）

## 测试范围与方法

- 常规回归 `npm test`：204/204 通过；`npm run typecheck` 通过；`npm run test:sidecar` 12/12 通过；`npm run test:browser`（Chrome 无头）全绿、无 JS 异常。
- 离线评测 `npm run eval:offline`：50/50，Recall@10=1（词频基线，非真实模型）。
- **真实模型评测 `npm run eval:live`：50 题仅 5 题通过（pass_rate=0.1），45 题全部在 grounding 阶段被拒**；检索指标仍全满（Recall@10=1、上下文精度=1、引用原文准确率=1）。
- **线上真实知识库实测**（运行中的 8730 服务，16 篇文档/263 条事实）：3 个可回答问题（2026/2024/2023 公卫补助标准）模型草稿全部答对（99/94/89 元），但 3/3 被核验门拒掉；域外问题（量子计算）正确拒答；as_of 历史切片检索正确只返回当年文档。
- 对抗性探针：`tests/audit/bugs.test.ts`（30 个，断言"正确行为"，失败=实证 BUG）。运行：
  `node --import tsx --test --test-concurrency=1 tests/audit/bugs.test.ts`
  结果：**27 失败 / 3 通过（对照）**，另有 2 个内联探针实证，合计 **29 个实证 BUG**。

---

## P0 — 核心功能失效 / 安全

### 1. 核验门绞杀正确回答：真实评测通过率从文档宣称的 100% 跌到 10%
- 现象：`eval:live` 45/50 拒答，原因全部是「回答存在缺失或无效引用的句子」；线上 3/3 正确答案被拒。
- 根因组合：
  - **K1** `src/core/grounding.ts:26-37` `claimSentences` 不识别代码围栏，把代码块每一行、``` 围栏行都当成需要 [n] 引用的事实句。摘录类回答（golden 集全部是摘录题）必然被拒。
  - **K2/A4** 引导语（"原文如下："）与分号复句前半句没有紧跟引用 → 整条回答被拒（全有或全无）。线上 Q1 草稿「结论：…99元[1]。依据：…；…[1]。」即因分号拆分被拒（A4 实证）。
  - **A6** `grounding.ts:80` 数字正则把 ISO 日期 `2024-06-01` 拆成 `-06`、`-01` 带符号碎片去原文找 → 必然找不到。线上 Q2（as_of 问答）因此被拒。
- 回归来源：`docs/current-implementation.md:114-116` 与 `docs/validation/repository-live-2026-11-07.json` 记录的 50/50 依赖 `extractive_fallback` 策略（49/50 题走原文摘录回退）。该回退在 commit `99db049` 被移除，核验器未同步适配 → 通过率崩塌，文档结论过期。

### 2. G2 审阅队列向无权用户泄露私有文档原文（越权读取）
- `src/app/routes/learn.ts:237` GET /review 直接返回 `payload`（含 `quote` 逐字原文、new_object、old_objects），只对 `sources` 做了 ACL 过滤。任何同租户用户（含 viewer）可读到私有文档引文。探针 G2 实证。
- 同族：`reviewConsultPrompt`（learn.ts:38-110）把 payload.quote 与同主语全部事实（无 ACL 过滤）喂给模型并返回答案。

### 3. G1 只读角色可裁决事实审阅（缺 requireEditor）
- `learn.ts:303` POST /review/:id/resolve 无角色校验；`resolveReview`（learning.ts）亦无。viewer 可 accept_new/reject_new/merge/supersede 任意事实。探针 G1 实证（200 而非 403）。对比：删除实体有 requireEditor。

### 4. G3 记忆晋升自审自批
- 提交者本人可调用 resolve 批准自己的 memory_promotion，立即生成 `acl:['tenant:public']` 的公开文档（learn.ts:315-330）。"晋升需人工审阅"形同虚设。探针 G3 实证。

### 5. C1 同名文件上传跨用户覆盖他人文档
- `src/core/ingestion.ts:166-199` `existingDocument` 按 `upload:文件名` URI 匹配文档，不区分上传者。用户 B 上传与 A 的公开文档同名的文件（内容不同）→ 直接成为 A 文档的 v2，A 的内容被覆盖。探针 C1 实证。

### 6. J3 URL 摄入 SSRF
- `documents.ts:110` /url 与 `ingestion.ts fetchUrl` 只校验 http/https 前缀，不禁止回环/内网/链路本地地址，`redirect:'follow'` 后也不复检。探针用本机 stub HTTP 服务实证：内网响应被成功抓取入库。服务监听 0.0.0.0，局域网部署时可被用来探测内网。

### 7. E1 不同 ACL 文档印证同一事实 → 事实 ACL 变空集，对所有人消失
- `src/core/learning.ts:~800` `mergeOrArbitrate` 把事实 ACL 更新为「旧事实 ACL ∩ 新文档 ACL」。finance 文档与 engineering 文档印证同一断言 → 交集 [] → `canRead` 默认拒绝 → 事实对所有人（含 owner）不可见。探针 E1 实证。

### 8. E2 无日期候选把有有效期事实扩张为无限 → 复活已过期事实
- `learning.ts:806-807`：合并时 valid_from/valid_to 取 min/max，任一为 null 即置 null。2024-01-01→2025-01-01 的过期事实被无日期候选印证后变成永久有效。时间线/历史问答准确率直接受损。探针 E2 实证。

---

## P1 — 数据完整性 / 检索准确率

### 9. A1 数字子串误配：错误数字可通过确定性核验
- `grounding.ts:82` 用 `compactSource.includes(number)` 子串匹配：证据「15%」放行回答「5%」（5% ⊂ 15%）。抽取侧 `quoteContains`（learning.ts:~330）专门做了数字边界防护，核验侧却没有。语义校验开启时可能兜住，但确定性防线有洞。探针 A1 实证（A2「100元⊄1000元」对照通过）。

### 10. B1 重建检索索引与摄入的向量输入不一致
- 摄入/恢复：`标题：{title}｜章节：{headings}\n{text}`（ingestion.ts:234-235、trash.ts restore）。
- 重建：`reindexing.ts:8` 只用裸 `chunk.text`。
- 后果：执行 README 推荐的「更换向量模型后重建索引」后，标题/章节词从稀疏向量消失（探针实证 `zephyr` 丢失），稠密向量也偏离摄入分布 → 重建后检索行为与新入库文档不一致。

### 11. D1 沿革中间文档进回收站 → 新旧两代政策同时生效
- `trash.ts trashDocument` 不处理延续边（只有 purge 调 `removeContinuationLinks`）。A→B→C 中 B 进回收站：A 的排除条件要求后续 active（B 已 tombstoned）→ A 复活；C 照常生效 → 检索同时返回两代矛盾内容。探针 D1 实证（gen-a、gen-c 同时召回）。

### 12. D2 后续文档不可读 → 可读前序从检索整体消失
- `retrieval.ts:144` 排除前序时只查后续 `status='active'`，不查当前用户能否读后续。后续是私有文档时，普通用户既看不到后续、也丢了前序 → 该政策链对其完全不可见。探针 D2 实证（0 命中）。

### 13. C2 他人私有同名文件挡住我的上传
- `existingDocument` 命中他人私有 `upload:secret.pdf` → `canRead` false → 抛 404「目标文档不存在或无权访问」。用户 B 永远无法上传同名文件。探针 C2 实证。

### 14. C3 无 URI 文本去重跨越 ACL
- `ingestion.ts:222` 默认去重按 content_hash 全租户匹配、不查 ACL。B 摄入与 A 私有文档相同内容 → 静默返回 A 的 document_id（duplicate=true），B 得不到自己的副本，且泄露私有文档 ID。探针 C3 实证。（API 的 /text 走 confirmDuplicates='ask' 可避开；目录同步与直接 ingestParsed 路径命中。）

### 15. F1 「记住…」开头的疑问句被记忆指令劫持
- `answering.ts:265` 正则把「记住密码的规则是什么」当成记忆写入，回答「已记入个人记忆」，问题被吞。探针 F1 实证。

### 16. F2 不相关短问题被拼上上一轮问题检索
- `answering.ts:111-115`：question.length≤12 或含 FOLLOW_UP 字（这/那/再/其…）即拼接上一轮用户问题。新话题「报销流程」被检索成「年假有几天 报销流程」。探针 F2 实证。

### 17. H2 缺口列表泄露其他用户的私密问题
- 拒答自动 upsertGap（answering.ts），GET /gaps（learn.ts:450）无角色/用户过滤。探针用含身份证号的问题实证：viewer 可见。

### 18. I1 审阅 merge 复制证据丢失 span
- `learning.ts resolveReview` merge 分支 INSERT fact_evidence 不带 span → 合并后引用高亮定位丢失；且不去重，反复 merge 会堆积重复证据。探针 I1 实证。

---

## P2 — 功能缺陷 / 鲁棒性

### 19. A7/A8 康熙部首变体字（PDF 常见）未归一
- 线上 2023 通知 PDF 文本含 `⼈`(U+2F08) 等部首字。`tokenize`（embeddings/index.ts:26-44）CJK 范围不含部首区 → 字被丢弃、「人均」bigram 缺失 → 稀疏召回受损（探针 A7）；`normalizeName`（learning.ts:62）不做 NFKC → 同名实体分裂（探针 A8）。`cleanParsedText` 只做 NUL/代理对清理，不做 NFKC。

### 20. F3 compare 子查询把词拆碎
- `answering.ts:150-158` 按单字「和/与」切分：「和平协议的内容是什么」→ 子查询「平协议的内容是什么」。探针 F3 实证。

### 21. H1 文档列表 total = 当前页条数
- `documents.ts:221` `total: visible.length` 是 ACL 过滤后的本页数量。25 篇文档 limit=10 → total=10，前端分页失效。探针 H1 实证。

### 22. J1/J2 分页参数非数字 → 500
- `?limit=abc` → `LIMIT NaN` → PG 报 `column "nan" does not exist` → 500（应 400）。/documents 与 /conversations 均实证；/facts、/entities、/graph 的 limit 同模式。

### 23. 空 status 参数列出回收站文档（内联实证）
- `documents.ts:197-205` `params.status ?? 'active'` 后 `if (status)`：`?status=` 空串 → 不加状态过滤 → tombstoned 文档标题出现在正常列表。

### 24. 关系槽位年份口径漏洞（内联实证）
- `relation-types.ts relationSlot`：`2030年目标为` → `relation:target:2030`，`目标为` → `relation:target:`。同一指标带年份与不带年份的两种说法槽位不同 → `factsConflict` 不判冲突 → 矛盾目标值并存。

### 25. 抽取任务绑死发起人权限，ACL 变更后永久失败
- `enrichment-queue.ts:137`：任务主体失去文档读权限即抛「任务主体无法访问当前文档」，无 owner 兜底。**线上库现有 3 篇文档处于该永久失败态**（银杏八号个人资料、紫藤九号内部资料、非法ACL文档）。

### 26. 文档/验证报告过期
- `docs/current-implementation.md:114` 宣称 live 50/50，与当前代码实测 5/50 不符（见 P0-1）；:97 写「Node 全量 143 项」，实际已 204 项。

---

## P3 — 设计/性能/次要（代码审查发现，未单独探针）

27. `sparseVector` 按词频取 top-96：长 chunk 中低频但高区分度的词被截掉，稀疏召回受损（embeddings/index.ts:46-56）。
28. ark 向量 `instructions`（含 "Query:" 前缀）对文档与查询同样下发（embedMany/embedQuery 同路）；非对称模型应区分 doc/query 指令，可能压低语义检索准确率。
29. 抽取/合并硬编码领域词表：`organizationName` 只认卫生院/医院…等后缀，`planningScope` 只认中国省名与「规划」标题（learning.ts:~340-360）——通用产品里的公卫领域过拟合，其它领域并列机构拆分/口径隔离失效。
30. `factsForEntities` 每条事实 3 次查询（N+1）；`linkEntities` 每次检索全表扫 entities+entity_aliases（无租户过滤的别名全扫）；大库性能隐患（retrieval.ts:188-270）。
31. `linkEntities` 短查询子串匹配（`normalizedName.includes(normalizedQuery)`）+ 无 ORDER BY 的 `slice(0,5)` → 实体链接噪声且结果不确定。
32. `runDailyReflection` 单租户失败 throw → 其余租户当日维护被跳过（scheduling.ts）。
33. `checkSemanticGrounding`/`reflectQueries` 用贪婪 `/\{[\s\S]*\}/` 提取 JSON，模型多输出一个花括号即解析失败 → 503。
34. GET /entities/:id 的 `as_of` 不走 `normalizeAsOf`，非法日期静默按字符串比较过滤。
35. `resolveReview accept_new` 用 `newFact.valid_from ?? today` 截断旧事实：新事实无日期时旧事实被截到今天，即使新断言是历史性的。
36. 主服务 `host=0.0.0.0` + 静态 Bearer 令牌：局域网内任何持令牌者全权访问（原生对话做了回环限制，主 API 没有）；令牌明文存 users 表。部署提示。
37. `purgeTrashedDocument` 的孤立实体清理是全租户的：任何一次彻底删除都会清掉「当前无事实引用」的实体（含刚建还没抽到事实的实体）。

---

## 通过项（值得肯定）

- 检索 ACL 默认拒绝、MCP/knowledge-query 的逐层 ACL（文档/切块/事实/实体/证据版本）非常严密，未发现越权读取原文的路径（审阅队列除外，见 P0-2）。
- 沿革日期校验（插入保序、环检测、advisory lock）、as_of 历史版本选择、精确标题回溯历史文档：线上实测正确。
- 重试/退避实现与配置注释一致，线上观测到 429 自动退避重试成功；4xx 不重试。
- 回收站/恢复的事务边界、向量失败不发布半套索引、彻底删除的派生清理：回归与探针均未发现破绽（延续边除外，见 P1-11）。
- 域外问题拒答、引用编号边界校验、千分位/中文数字归一（A2/A3/A5 对照通过）。
- 边车解析、浏览器冒烟、类型检查、204 项回归全绿。

---

## ⚠️ 测试过程事故与恢复（如实记录）

清理线上测试残留时，按「标题精确匹配」删除会话，误删了 17 条同标题会话——其中 4 条是本次审计产生，其余 13 条是用户当天早些时候及并行测试会话（22:43–23:08）的同名提问。
已从 `traces` 表（每次 ask 的完整问答记录）**重建全部 17 条会话与 34 条消息**（含原时间戳、trace_id、mode、confidence、latency），并重建 4 条缺口、4 条失败候选用例。
不可恢复部分：被删会话的 `citations` 引文行与 assistant 消息的 `answer_failure` 诊断 JSON（traces.meta 仍保留 evidence_ids、top_score、threshold、answer_strategy 等核心信息）。
教训：清理脚本应按本次会话产生的 ID 精确删除，而不是按内容匹配。

## 复现

```sh
node --import tsx --test --test-concurrency=1 tests/audit/bugs.test.ts   # 27 失败 = 27 实证 BUG
npm run eval:live                                                        # pass_rate≈0.1（真实模型）
```
探针文件：`tests/audit/bugs.test.ts`（不在 npm test 的 tests/*.test.ts  glob 内，不影响常规回归）。
