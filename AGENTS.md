# AGENTS.md

## 强制规则

任何备选方案或备选组件（alternative / fallback / 可选依赖 / 临时替代实现），必须先征得用户明确同意才能使用。不确定是否算备选，就当成备选先问。

数据库结构必须有完整且准确的注释：

- 所有表和所有字段都必须有注释。PostgreSQL 使用 `COMMENT ON TABLE` / `COMMENT ON COLUMN`，写在 `src/db/schema.sql` 中对应表定义之后（ALTER 追加的列在 ALTER 语句后补注释）。
- 注释必须准确反映代码中的实际语义：枚举取值、JSONB 结构、单位/量纲、默认值含义、预留未用字段要如实标注，不得含糊或臆造。
- 新增/修改/删除表或字段时，必须在同一次改动中同步更新对应注释；删除字段时一并删除其注释。
- 注释随 schema 幂等执行（COMMENT ON 可重复运行），`initSchema()` 会自动刷新到数据库。
