# 知织 KnoWeave

个人知识库：导入文档，基于原文引用问答，将有出处的候选事实送入审阅与增量合并。

当前主服务是 `src/` 下的 Node.js / TypeScript，前端位于 `knowweave/web/`。`sidecar/main.py` 提供 PDF / DOCX 解析；`knowweave/app/` 是并存的旧 Python 服务，不是根目录启动脚本的入口。

## 启动

需要 Node.js 24.9+。安装 Node 依赖后，从模板创建本地配置，填写生成模型和向量服务参数：

```sh
pnpm install
cp config.example.toml config.toml
npm run dev
```

默认地址为 `http://localhost:8730`。未配置外部数据库时使用 `data/pglite`。生成模型不可用时可回退到带引用的原文摘录；文档与查询的向量化仍需要可用的向量服务。

需要 PDF / DOCX 时，按配置中的解释器路径准备解析环境：

```sh
python3.12 -m venv knowweave/.venv
knowweave/.venv/bin/python -m pip install -e ./knowweave
```

主服务可自动拉起解析边车。知识库对话统一调用 `/api/v1/ask`，独立运行时调试界面默认不启动。

## 检查

```sh
npm run typecheck
npm test
npm run build
```

Node 回归使用临时 PGlite 与离线模型/向量桩，覆盖摄入、版本、切块、事实审阅、问答、历史检索、MCP 与页面交互逻辑，不使用现有 `data/`。

当前能力和接口见 [当前实现说明](docs/current-implementation.md)。[设计方案](ai-knowledge-base-design/ai-knowledge-base-design.html)保留长期目标；[原始审计](docs/implementation-audit-2026-11-06.md)记录修复前的问题。第三方组件与许可证见 [声明](THIRD_PARTY_NOTICES.md)。
