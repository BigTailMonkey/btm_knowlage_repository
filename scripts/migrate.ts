/** 单独执行数据库迁移与演示数据初始化。 */
import { settings } from '../src/config.js'
import { closePool, initSchema, seedIfEmpty } from '../src/db/index.js'

try {
  await initSchema()
  if (settings.seedDemo) await seedIfEmpty()
  console.log('数据库迁移完成')
} finally {
  await closePool()
}
