/**
 * 谓语归一：把抽取出来的自由文本谓语收敛成有限的关系类型，用于实体图谱的边标签和实体详情分组。
 *
 * 原文谓语（fact.predicate）保持不变，仍然用于溯源和展示细节；这里只提供一个稳定的
 * 关系类型视图，保证图上能看出「关系模式」，而不是每条边都是独一份的长句。
 */

import { predicateStem, yearsIn } from './value-shapes.js'

export interface RelationType {
  /** 稳定标识，前端与接口字段使用它做分组和配色 */
  key: string
  /** 边标签与分组标题用的短名，2 到 4 个字 */
  label: string
  /** 图例与编辑器里的一句话说明 */
  description: string
  /**
   * 单值关系：同一主语在同一口径下只应有一个宾语（定义、目标值）。
   * 这类关系换个说法（等于/计算方式为、达到/2030年目标为）算同一条，用于去重与冲突判定；
   * 多值关系（举措、要求、限值）可以并列存在，不互相取代。
   */
  singleValued: boolean
}

export const RELATION_TYPES: RelationType[] = [
  { key: 'definition', singleValued: true, label: '定义/口径', description: '指标的定义、计算方式、统计口径，例如“计算方式为”“定义为”“等于”。' },
  { key: 'target', singleValued: true, label: '目标值', description: '规划或考核要达到的数值，例如“2030年目标为”“降低到”“达到”。' },
  { key: 'threshold', singleValued: false, label: '标准/限值', description: '数量或比例的硬性界限，例如“不少于”“不低于”“标准为”。' },
  { key: 'frequency', singleValued: false, label: '频次/时限', description: '多久一次、要持续多久，例如“每年至少”“时限为”“疗程为”。' },
  { key: 'timing', singleValued: true, label: '时间', description: '发布日期、生效日期、有效期等。' },
  { key: 'composition', singleValued: false, label: '归属/包含', description: '整体与部分、分类与项，例如“包括”“分为”“属于”。' },
  { key: 'responsible', singleValued: false, label: '实施主体', description: '由谁牵头、负责、承担，例如“牵头推进”“由…负责”。' },
  { key: 'applicability', singleValued: false, label: '适用范围', description: '适用对象、覆盖范围，例如“适用于”“服务对象”。' },
  { key: 'requirement', singleValued: false, label: '要求', description: '应当、必须、不得一类的义务性要求。' },
  { key: 'action', singleValued: false, label: '举措', description: '开展、举办、建立、提供、发布一类的具体动作。' },
  { key: 'other', singleValued: false, label: '其它', description: '未归入以上类型的谓语，图上直接显示原文谓语。' },
]

const OTHER: RelationType = { key: 'other', label: '其它', description: '未归入以上类型的谓语，图上直接显示原文谓语。', singleValued: false }

/** 顺序即优先级：先匹配到的类型胜出，宽泛的规则（要求、举措）放在最后。 */
const RULES: Array<{ key: string; pattern: RegExp }> = [
  { key: 'definition', pattern: /定义为|定义|计算(方式|公式|方法)为|计算为|等于|口径为|口径是|是指|指的是|即为/ },
  { key: 'target', pattern: /目标为|目标值|目标降|目标达到|规划目标|降低到|提高到|提升到|控制在|保持在|达到|降至/ },
  { key: 'threshold', pattern: /不少于|不低于|不超过|不高于|以上|以下|标准为|限值|上限|下限/ },
  { key: 'frequency', pattern: /每年|每月|每季度|每周|每天|每日|频次|时限|疗程|留观时长|时长为|次数为/ },
  { key: 'timing', pattern: /发布日期|发布于|施行日期|生效日期|实施日期|起止|有效期|时间为/ },
  { key: 'composition', pattern: /包括|包含|分为|分成|属于|隶属|构成|涵盖|组成/ },
  { key: 'responsible', pattern: /牵头|负责|承担|主管|由.{0,10}(实施|负责|开展)/ },
  { key: 'applicability', pattern: /适用于|适用|服务对象|面向|针对|覆盖/ },
  { key: 'requirement', pattern: /应|须|需|必须|不得|宜|禁止/ },
  { key: 'action', pattern: /开展|举办|建立|实施|提供|组织|编写|发布|选用|制定|培训|筛查|接种|随访|访视|发放|签订|监测|评估|评价|指导|管理|推进|调整/ },
]

const TYPE_BY_KEY = new Map(RELATION_TYPES.map((type) => [type.key, type]))

/** 谓语归一：返回稳定的关系类型，永远不返回 undefined（未识别时给“其它”）。 */
export function relationOf(predicate: string | null | undefined): RelationType {
  const text = String(predicate ?? '').trim()
  if (!text) return OTHER
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return TYPE_BY_KEY.get(rule.key) ?? OTHER
  }
  return OTHER
}

/** 接口里的紧凑形式：{ key, label }，前端直接拿来当边标签和分组标题。 */
export function relationRef(predicate: string | null | undefined): { key: string; label: string } {
  const relation = relationOf(predicate)
  return { key: relation.key, label: relation.label }
}

/**
 * 同一「关系槽位」的判定键。
 *
 * 单值关系（定义、目标值、时间）同一主语只应有一条：换了说法（等于 / 计算方式为）仍是同一条，
 * 因此按关系类型 + 谓词里出现的年份归并；年份不同（2025年目标 vs 2030年目标）算两个口径。
 * 多值关系和归不进类型的谓语按谓语词干归并，去掉情态词与尾巴（应具备资格 / 应当具备）。
 *
 * 抽取与数据修复都用它做去重和冲突判定：之前只按 predicate 精确匹配，换个措辞就变成另一条。
 */
export function relationSlot(predicate: string | null | undefined): string {
  const relation = relationOf(predicate)
  const years = yearsIn(predicate).join(',')
  const stem = predicateStem(predicate) || String(predicate ?? '').trim()
  if (relation.singleValued) return `relation:${relation.key}:${years}`
  return `predicate:${stem}:${years}`
}

/**
 * 两条事实是不是同一条断言（用于去重，只有在主语宾语相同时才调用）。
 *
 * 同一关系槽位（等于 / 计算方式为）算同一条；归不进任何类型的谓语（other）没有可比的关系语义，
 * 也按同一条处理——「做」和「为正常产妇做」就是同一句话的两种抽法。
 * 冲突判定不要用这个口径：other 没法区分动作，会把同一主语的多个举措当成互相矛盾。
 */
export function sameAssertion(leftPredicate: string | null | undefined, rightPredicate: string | null | undefined): boolean {
  if (relationSlot(leftPredicate) === relationSlot(rightPredicate)) return true
  if (relationOf(leftPredicate).key === 'other' || relationOf(rightPredicate).key === 'other') return true
  // 一个词干是另一个的前缀，说明只是抽多抽少（访视 / 接到通知单后72小时内访视患者）
  const left = predicateStem(leftPredicate)
  const right = predicateStem(rightPredicate)
  if (left.length >= 4 && right.length >= 4 && (left.startsWith(right) || right.startsWith(left))) return true
  return false
}
