# 当前知识库与问答实现

更新：2026-11-07（Asia/Shanghai）。本文是当前 Node 主服务的行为和验收记录。设计 HTML 正文保留长期架构；原始审计是修复前快照，不能作为当前缺陷清单。权限、计费、预算按用户指定范围暂缓。

## 已实现的核心链路

| 能力 | 当前行为 |
|---|---|
| 知识库对话 | AI 对话通过 iframe 加载完整 DSH 原生应用，使用其原生流式传输与交互，默认禁用网页搜索/抓取并接入带当前身份认证的只读知识库 MCP 工具；研究台调用 `/ask`，提供检索、引用、历史消息与个人记忆。两者的会话分别保存。两者及后台抽取和校验均使用项目配置中的 `[model]`，原生对话每次启动时加载该配置。 |
| 文档身份与版本 | 同一来源更新生成不可变版本；相同内容跳过；回退历史内容生成新版本。支持显式 `doc_id`、稳定上传身份、目录相对路径身份。不同来源不会仅因内容相同被合并。 |
| 文档延续与沿革 | 政策等同一主题跨年发布、名称和内容都变化的文档按“前序 → 后续 + 生效日期”登记为线性沿革链（`document_continuations`），不是同一文档的版本。默认检索只取结算日当时有效的一篇：后续生效后前序退出默认检索，后续在生效日前不进入默认检索；`as_of` 按结算日期选择当时那一代，显式 `doc_ids` 或精确《标题》仍可读历史。旧文档独占支撑的事实不会作为现行证据被引用。链上每个文档最多一个前序和一个后续；删除/回收站保留关系，彻底删除时清理关系边。 |
| 回收站与恢复 | 删除即移入回收站（`documents.status='tombstoned'`，记录 `deleted_at/deleted_by`），只保留文档本体：原文、版本、结构块与原始文件；检索单元与向量、事实证据、摘要当场清理，单源事实随之撤回，分享其他出处的共享事实保留，相关待审项立即关闭。恢复时用已存结构块重新切分、重新向量化，并重新排队抽取事实与实体，旧证据不会被“复原”；向量生成失败时文档留在回收站，不发布半套索引。恢复只重建当前版本的检索单元与引用区间；更早版本仍可读原文，但不再重建检索单元。彻底删除清除文档、版本、结构块、检索单元、原始文件任务、仅由该文档支撑的事实、引用、评测期望与该文档独有的孤立实体。保留期由 `[trash].retention_days` 控制（默认 30 天，0 表示不自动清除），每日维护按保留期彻底删除。 |
| 持久摄入 | 返回任务前保存完整输入和主体 ID，不保存身份 token。数据库原子领取、30秒心跳、2分钟失联租约恢复，失败10秒后自动重试，最多3次；成功版本和结构块事务提交，失败保留旧版本。原始文件 base64 存 jobs，在文档彻底删除时随之清除；平常仍没有自动清理策略。 |
| 单步恢复 | 解析检查点持久化；`index` 从检查点继续，`parse` 重做解析。解析失败进入人工修正待审项，修正文保留来源身份；重试成功自动关闭待审项。 |
| 多格式解析 | 本地文本/Markdown/HTML；边车支持 Docling、MinerU CLI、pypdf、python-docx、图片/扫描PDF OCR、带时间戳的音视频 ASR。自动路由按质量阈值切换引擎；全部失败返回422，不把乱码作为成功文档。可选引擎需先安装，见 README。 |
| 结构与定位 | 估算 token 预算切正文；表格、代码、公式原子保存。跨页片段保留各自坐标。引用记录规范化原文的 UTF-16 区间与版本 ID，页面打开对应旧版并高亮；缺失的 PDF bbox 保留 null。版式预览使用 PDF.js 按页渲染，无缩略图侧栏，铺满预览面板；引用位置通过文本层匹配并以脉冲色块标出，不依赖解析器提供 bbox。 |
| 检索模型 | 支持现有云端 dense+词频 sparse，以及 `hybrid` 服务返回的 dense+learned sparse。本地可选 BGE-M3 `/embed`；RRF 后可配置真实语义重排 `/rerank`，未配置时明确使用规则重排，配置服务出错时不伪装规则结果。 |
| 索引重建 | `reprocess scope=index` 从所有已存版本的子块重建向量，事务替换，保留 chunk ID、事实证据与历史引用；向量生成失败不发布半套索引。更换模型后须对已有文档重建，当前不是整库离线双索引切换。 |
| 问答模式 | quick 单轮；deep 最多三轮补检索；compare 并行召回与引用表格；graph 默认两跳、最多三跳，并可使用有原始证据支持的社区摘要；timeline 使用历史版本与有效事实。 |
| 历史语义 | `as_of=YYYY-MM-DD` 选择截至该日工作区已保存的最新版本并过滤事实有效期。不是完整双时间数据库，不推测从未保存的历史内容。 |
| 回答验证 | 逐句检查引用编号、原文、数字、单位和否定方向，再由独立模型调用进行语义判断。未通过核验时拒答，模型调用失败时返回错误。原文中的数字方括号按原文处理。 |
| 事实质量 | 模型分批抽取全文。候选必须有完整引文，实体名须完整，证据保留原文区间。模型失败或返回不完整时标为抽取失败。与知识库已有信息不冲突的候选（包括知识库中尚无的事实）直接生效，单源或低置信也不例外；只有与已有事实冲突时才进入审阅队列，多源一致且有效期更晚时按来源票自动取代。删除或更新来源使失去有效出处的事实撤回。 |
| 抽取进度 | 事实与实体抽取进行中时，`/documents/extractions` 返回实时进度：已完成批次/总批次作为底数，实际发出的模型与向量请求数作为进度，并给出已用时间和按批次速度推算的剩余时间。请求计量通过异步上下文累加，覆盖退避重试的每次实际请求，普通问答与检索不受影响。进度是内存里的实时值，累计请求数随检查点一起续上，重试后接着之前的数字继续累加。 |
| 抽取续传 | 事实与实体抽取每完成一批就把已验证的候选、已合并的候选数、累计请求数写进 `jobs.payload.checkpoint`。失败、手动重试或进程崩溃后队列恢复时从断点继续，已完成批次不再调用模型，已合并的候选不再重做。提示词规则变化（提示词指纹不同）、段落重新索引（chunk 失效）或批次总数变化时检查点作废并从头抽取；抽取成功后清空。 |
| 强制重抽 | `POST /documents/extractions/retry` 与 `POST /documents/:id/reprocess` 接受 `reset=true`：先丢掉该文档当前版本的抽取检查点再入队，已完成批次不再复用、已合并候选全部重算。`reset` 缺省为 `false`，即沿用断点续跑。正在运行的任务不会被重置，接口返回 `queued=0`。知识库的失败卡片上有「重试抽取」（续跑）与「从头重抽」（reset）两个入口。 |
| 模型任务重试 | 单次模型调用（生成/抽取/校验/流式对话首 token 之前）遇到 429、5xx、超时或网络故障时，按 `[model]` 的退避策略自动重试（默认 4 次，2s→30s，尊重 Retry-After）；4xx 参数类错误不重试，重试耗尽后错误信息标注总尝试次数。文档索引和事实抽取由独立队列处理。知识库列出失败原因，支持单条和批量重试当前版本。记忆抽取重试成功后继续审阅流程。研究台可以重试同一次提问，评测失败项可单独或批量重跑。 |
| 实体身份 | 先精确匹配名称或别名，再在同租户、同类型和相同可见范围内以向量找候选。模型确认同一实体且置信度达到 0.9 时合并。语义判定调用失败时报告抽取失败。 |
| 来源与富化 | 显式 `source_trust` 与解析质量分开，证据基础权重为两者乘积，独立文档去重投票；低来源票重不能自动取代更强冲突。导入新文档或更新版本时，检索索引写入成功后自动抽取事实与关联实体。也支持手动重新抽取。 |
| 摘要与维护 | 有当前有效证据的事实生成实体摘要与 ACL 分区内连通社区摘要，采用可追溯摘录，不是另一个无出处知识源。更新/删除立即失效；定期重算，聚类缺口、撤回孤立事实、清理过期记忆，对超过30天未使用证据每30天衰减一次。 |
| 每日维护 | 按工作区时区 `reflection.run_at`（默认03:00）逐租户运行，数据库记录每日完成状态，重启补跑；空值恢复间隔模式。 |
| 记忆与反馈 | 显式“记住这个：”“纠正一下：”“我的偏好：”存个人记忆并去重，不直接作为知识事实。记忆晋升先保存完整来源，再走相同事实抽取与审阅，取消无出处的泛化“记录”事实。消息反馈调整实际引用证据权重，重复投票不累加，负反馈真正降低分数。 |
| 评测闭环 | 导入/校对用例，实际调用 ask，记录 Recall@10、上下文精度、引用原文准确率、规则支持度、实际拒答结果、关键词和 p95；不创建用户聊天或个人记忆。失败请求进入候选集，人工校对批准后才参加黄金回归。 |
| 本地目录 | HTTP CLI 单次同步或持续监听，按内容哈希跳过未变文件、保留同名不同目录身份。忽略隐藏目录和符号链接；默认不删除远端文档。独立进程不直接访问服务的 PostgreSQL 数据库。 |

来源票重是可解释的加权一致性规则，不是自动判断互联网来源真假的模型。摘要是基于有效事实的可重算派生内容，不代表完整 GraphRAG 全局归纳算法。

## 接口与命令

知识库 API 前缀为 `/api/v1`，继续沿用现有 Bearer 身份机制。

```text
POST  /documents/upload          multipart: file, title?, acl?, doc_id?, source_uri?
POST  /documents/text            text, title?, acl?, doc_id?
POST  /documents/url             url, title?, acl?, doc_id?
GET   /documents/jobs            从数据库读取任务
POST  /documents/jobs/{id}/retry stage=parse|index, corrected_text?
GET   /documents/trash           回收站列表，含 deleted_at 与自动清除时间 expires_at
GET   /documents/{id}            ?version_id=... 返回对应规范化原文和区间，并附延续链
POST  /documents/{id}/continuation  other_doc_id, relation=continues|continued_by, effective_date, note?
DELETE /documents/{id}/continuation ?relation=continues|continued_by
DELETE /documents/{id}           移入回收站（软删除，可恢复）
POST  /documents/{id}/restore    恢复：重切分、重新向量化、重新抽取事实与实体
DELETE /documents/{id}/permanent 彻底删除，不可恢复
POST  /documents/{id}/reprocess  scope=facts（默认）|index|all
PATCH /documents/{id}/policy     source_trust:0–1, is_core:boolean
POST  /search                    query, top_k?, doc_ids?, source_type?, as_of?
POST  /ask                       question, mode?, top_k?, doc_ids?, as_of?, conversation_id?
POST  /feedback                  target_type=message|chunk, target_id, value=1|-1, comment?
POST  /evals/cases                cases:[{question,expected_docs,expected_keywords,should_refuse}]
PATCH /evals/cases/{id}           expected_docs, expected_keywords, should_refuse
POST  /evals/cases/{id}/approve
POST  /evals/run                  mode=answer（默认）|retrieval
POST  /mcp                       JSON-RPC tools/list、tools/call
```

`source_uri` 是目录 CLI 的 `directory:` 来源标识，需置于 multipart 文件字段之前。`source.text` 是规范化原文；区间 start/end 是 UTF-16 偏移，末尾不含，coordinate_system 为 `normalized-text-utf16`，不是原文件二进制位置。

DSH 原生对话可调用 `kb_search`（混合检索，可指定 `mode: graph` 和 `graph_hops`）、`kb_graph`（按方向和谓词查 1 至 3 跳路径）、`kb_query_facts`（对有可见原文支持的有效事实执行筛选、计数和分组）、`kb_get_document`（可按 `version_id` 核对原文，并返回延续关系）和 `kb_entity_timeline`。结构化统计的 `total` 按符合条件的事实记录计算，引用样例用于核对出处。其他 MCP 客户端还可调用 `kb_ask`、`kb_add_note` 和 `kb_report_gap`。

外壳（`knowweave/web/app.js`）看不到 iframe 内的 WebSocket，因此用两个信号判断对话是否还活着：DSH 页面每 4 秒发一次 `knowweave:heartbeat`，外壳连续 12 秒收不到（要求连续两次判定，间隔约 4 秒）才认定画面失效；随后回查 `/dsh-web`，进程重启换发的新入口地址会直接重新挂载，服务端仍报就绪但画面无响应时只重载一次，再失败就显示原因和重试入口。后台标签页和切离对话页期间 iframe 计时器会被浏览器节流，所以隐藏时不做判定，回到对话页或标签页重新可见时先给 15 秒宽限；首次挂载和进程重启后的宽限是 20 秒。传输中断时 DSH 页面标记 `data-knowweave-offline`，盖住输入区并拦下 Enter，避免断线提交只得到一条失败提示。

原生对话的入口固定为本机 `127.0.0.1`，其登录 Cookie 是 `SameSite=Strict`，所以 iframe 的主机名必须与打开页面一致：页面用 `127.0.0.1` 就加载 `127.0.0.1`，用 `localhost` 就加载 `localhost`。用局域网 IP 或域名打开时两者必然跨站、Cookie 无法传递，页面直接说明原因并给出本机地址，不再加载一个只会 401 的空白页。

```sh
npm run sync:directory -- /absolute/path/to/documents
npm run sync:directory -- /absolute/path/to/documents --watch
npm run eval:offline
npm run test:browser
npm run test:sidecar
```

目录 CLI 使用 `KNOWWEAVE_URL`（默认 `http://127.0.0.1:8730`）与 `KNOWWEAVE_TOKEN`（默认本地演示 owner-token）。缓存写入目录中的 `.knowweave-sync.json`，权限0600。watch 每10秒扫描，单文件最大30MB。

## 已执行验证与边界

- 类型检查、构建通过；Node全量143项通过；覆盖队列恢复、事务失败、版本引用、文档沿革、重排协议、实体裁决、维护、索引重建、来源策略、评测和记忆晋升。回收站另有专项回归：移入回收站只留文档本体并关闭待审项、恢复时重切分重向量化并重新排队抽取、向量失败不恢复、彻底删除清理原始文件与孤立实体、按保留期自动清除。
- Python 边车12项协议/路由回归通过。DOCX 顺序使用真实文件；Docling、MinerU、RapidOCR、ASR、BGE与Cross-Encoder部分使用契约替身，不能等同于真实权重验收。
- Chrome 无头浏览器实际通过原生聊天、点击引用、原文高亮、索引重建、来源策略、评测导入；未出现 JavaScript 异常。目录HTTP CLI首轮同步及缓存复用也已实际通过。使用临时用户目录和隔离数据库。
- Apple Vision 对中文页面截图实际离线 OCR 成功，返回文字、页号和 bbox。这不等同于复杂扫描PDF/公式数据集验收。
- 仓库20份源码片段、50条正向引用题的独立词频基线（修订v2）：50/50通过，Recall@10=1，引用原文准确率=1，规则支持度=1，关键词全命中率=1，按期望文档归属计算的上下文精度=1，最近一次p95约75ms（本机离线测试，不是生产延迟承诺）。离线阈值显式为0.2，生产默认0.36未改。全部是正向题，拒答准确率1不能说明负例拒答能力；缺失知识与拒答另有功能回归。
- CI 执行类型检查、Node 测试、构建、50 题离线检索评测和边车测试。离线评测门槛为通过率≥0.98、Recall@10≥0.85、按文档归属计算的上下文精度≥0.75。真实模式另要求引用原文准确率≥0.98，且至少 95% 的题成功调用生成模型。

**仍待真实环境验收：** 本机可选重型依赖下载遇网络超时，Docling/MinerU/Whisper/BGE/Cross-Encoder权重未全部安装和实测；本地可选链路不能算已通过真实权重验收。用户已于2026-11-07明确授权向配置的火山引擎发送20份源码片段与50题并产生正常API用量；已在隔离数据库完成真实模型验收。先前自动审批拒绝已由这次具体授权解除，完整结果及题集修订原因见下文。结果不外推到未验证的业务问答。

## 真实模型验收追踪

用户已明确授权本次数据外发及正常API用量；实际调用配置的火山引擎，不改现有知识库。首轮完整50题模型调用全部成功，但仅27/50通过：Recall@10=1、文档归属上下文精度约0.268、真实回答/拒答正确率0.56、p95=8267ms。[首轮原始结果](validation/initial-live-2026-11-07.json)保留供对照，不改写失败记录。

首轮题目要求“具体实现”，实际只提供每个符号附近7行片段，不能保证具备解释完整函数的证据；模型的部分拒答合理。v2明确要求摘录已提供的符号片段并引用，定位为来源查找回归，不当作业务知识理解或完整代码实现评测。没有增加授权之外的数据源或修改生产阈值。

同时修复实际回答问题：带引用的原文出现“资料不足”不再被全局关键词匹配误判为模型拒答；摘录优先保留问题中反引号指定的符号；精确《文档标题》在可见性和显式过滤之后约束来源，多个标题支持对比；独立抽取/核对调用使用独立SDK会话，避免上下文串题。中间复验因补充来源范围修复在17题后停止，不作为完整验收结果。

最终v2完整验收：50/50通过，生成调用50/50成功，Recall@10=1，文档归属上下文精度=1，引用原文准确率=1，规则支持度=1，关键词全命中率=1，正向题回答/拒答正确率=1。使用生产阈值0.36，原有知识库未改动。[最终原始报告](validation/repository-live-2026-11-07.json)。

**重要限制：** 49/50题采用安全的原文摘录回退，仅1/50题的生成文本通过规则与独立语义核对直接保留（该次独立核对成功）。当前核对对代码围栏、附加解释与改写较保守，不能把最终答案通过率100%说成生成式回答准确率100%。p95=6703ms，未达到设计≤3000ms目标；这是明确未达标项。题集全为正向片段引用题，不能证明未知问题拒答、业务知识理解、完整代码实现解释或复杂解析能力达标。

评测报告区分模型成功调用、独立语义核对与原文摘录回退；引用准确率测原文出处匹配，规则支持度不能代替独立人工语义评分；当前上下文精度按期望文档归属计算，不是人工标注的片段级相关性。3秒p95目标需单独检查，质量门槛通过不代表延迟目标通过。

## 保留的架构差异与后续范围

当前采用 PostgreSQL + JSONB 向量、数据库持久队列和原生 HTML/CSS/JS，没有迁移为 Qdrant、Redis/BullMQ、Next.js。默认仍使用已配置云端向量与规则重排，只有显式启用可选模型链路才使用 learned sparse/Cross-Encoder。SDK 实际通过子进程运行，研究台业务消息入库。AI 对话由 DSH 原生应用负责流式输出和会话存储；研究台 `/ask` 仍返回完整 JSON，完整运行时状态未接入 PostgreSQL。

飞书/Notion/RSS连接器、图像多模态向量搜索、IM/邮件机器人、完整历史快照影子回放、冷热归档与全部失败请求的完整轨迹还在路线图。权限、计费、预算与供应商账单对账按本轮范围暂缓。不能将本次核心功能修复描述为整个 M0–M3 设计已全部完成。

适配器依据：[BGE-M3](https://bge-model.com/bge/bge_m3)、[CrossEncoder](https://sbert.net/docs/package_reference/cross_encoder/model.html)、[Docling](https://docling-project.github.io/docling/reference/document_converter/)、[MinerU](https://github.com/opendatalab/MinerU/blob/master/docs/en/usage/quick_usage.md)、[RapidOCR](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/)。
