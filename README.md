# 知织 KnoWeave

个人知识库：导入文档，基于原文引用问答，将有出处的候选事实送入审阅与增量合并。

当前主服务是 `src/` 下的 Node.js / TypeScript，前端位于 `knowweave/web/`。`sidecar/main.py` 提供多格式解析、OCR / ASR 和可选本地检索模型接口；`knowweave/app/` 是并存的旧 Python 服务，不是根目录启动脚本的入口。

## 启动

需要 Node.js 24.9+。安装 Node 依赖后，从模板创建本地配置，填写生成模型和向量服务参数：

```sh
pnpm install
cp config.example.toml config.toml
npm run dev
```

默认地址为 `http://localhost:8730`。未配置外部数据库时使用 `data/pglite`。启动前会向 `[model]` 配置的模型发送简短探测请求，成功收到生成文本后才启动服务。配置缺失、认证失败或接口无法生成时，启动报错退出。运行中的模型故障会在对应请求或任务中报错。文档与查询的向量化需要可用的向量服务。

需要 PDF / DOCX 时，按配置中的解释器路径准备解析环境：

```sh
python3.12 -m venv knowweave/.venv
knowweave/.venv/bin/python -m pip install -e ./knowweave
```

可选安装（首次加载模型可能下载权重；MinerU 需另行安装其 CLI）：

```sh
knowweave/.venv/bin/python -m pip install -e './knowweave[parsing,ocr,asr,models]'
```

macOS 安装 Swift 命令行工具后可使用 Apple Vision 离线 OCR；其他平台支持 RapidOCR，或安装 Tesseract 及语言包。通过 `GET http://127.0.0.1:8732/capabilities` 检查可用依赖；该结果不表示模型权重已下载或业务准确率已验收。可按需仅安装一个 extra。

本地 BGE-M3 与 Cross-Encoder 配置示例见根目录 `config.example.toml`。先预热模型，再启用服务；更换向量模型后从文档详情“重建检索索引”更新已有文档。文档成功解析并建立检索索引后自动抽取事实与关联实体。文档详情可设置来源可信度和核心标记，或手动重新抽取事实。

主服务可自动拉起解析边车。AI 对话嵌入完整 DSH 原生界面，保留原生流式输出、工具交互、附件与会话管理，服务启动后即在后台预热，打开对话页直接可用。研究台继续通过 `/api/v1/ask` 提供带引用的知识库问答；两者的会话分别保存。AI 对话默认关闭网页搜索与抓取，通过 DSH 原生 MCP 调用知识库检索、原文与时间线工具，证据不足时明确说明。原生工作区在启动时绑定默认所有者身份（已有绑定优先），检索沿用该身份的 ACL；其他身份可使用研究台。问答、事实与实体抽取、语义校验及原生对话共用项目配置中的 `[model]`。修改模型名、OpenAI 兼容接口地址或密钥后，重启主服务生效。

## 检查

```sh
npm run typecheck
npm test
npm run build
npm run test:sidecar
npm run eval:offline
# 已安装 Chrome 时：npm run test:browser
```

Node 回归使用临时 PGlite 与离线模型/向量桩，覆盖摄入、版本、切块、事实审阅、问答、历史检索、MCP 与页面交互逻辑，不使用现有 `data/`。

目录同步通过运行中的主服务操作，不直接打开数据库：

```sh
npm run sync:directory -- /absolute/path/to/documents --watch
```

使用 `KNOWWEAVE_URL` 和 `KNOWWEAVE_TOKEN` 指定服务地址和身份。目录缓存记录文件哈希，更新形成版本，默认不删除远端文档。

离线评测用 20 份仓库源码片段和 50 条正向题验证检索。真实模型的问答和引用另用 `npm run eval:live` 验证。历史评测结果记录在实现说明中。

当前能力和接口见 [当前实现说明](docs/current-implementation.md)。[设计方案](ai-knowledge-base-design/ai-knowledge-base-design.html)保留长期目标；[原始审计](docs/implementation-audit-2026-11-06.md)记录修复前的问题。第三方组件与许可证见 [声明](THIRD_PARTY_NOTICES.md)。
