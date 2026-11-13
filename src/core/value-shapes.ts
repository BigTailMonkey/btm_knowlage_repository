/**
 * 判断一个抽取出来的「名称」其实是不是一个值，而不是实体。
 *
 * 抽取模型经常把数值、比例、期限、频次、日期、公式当成宾语甚至主语，于是知识库里长出一批
 * 「按照规范要求进行…×100％」这样的假实体：它们不可能被再次指代，也没有任何关系，只会把
 * 图谱稀释成一盘散点。这里用可解释的形态规则兜底，配合提示词让模型直接写成 object_literal。
 *
 * 规则只认「形态上就不像名字」的写法，宁可漏判也不误杀：
 * 「2 型糖尿病患者」「15岁以上人群吸烟率」这类带数字的真实体必须保留。
 */

/* 量词/单位：数字后面跟这些才可能是值 */
const MEASURE = '个|人|名|位|次|种|份|张|条|项|类|级|天|日|周|月|年|小时|分钟|秒|岁|元|岁|倍|成|米|千米|公里|公斤|克|毫克|毫升|升|度|℃|%|‰'
/* 自带「统计口径」属性的词：出现这些说明是一个指标/人群名，不是值 */
const NAMED_STATISTIC = /率|人数|数量|比例|标准|目标|指标|患者|人群|儿童|居民|妇女|老年人|医师|护士|人员|机构|省份|城市/

const PURE_NUMBER = new RegExp(`^[+-]?\\d+(?:\\.\\d+)?\\s*(?:${MEASURE})?\\s*(?:以上|以下|左右|以内|及以上|及以下)?$`)
const NUMBER_RANGE = new RegExp(`^[+-]?\\d+(?:\\.\\d+)?\\s*[-~至到]\\s*[+-]?\\d+(?:\\.\\d+)?\\s*(?:${MEASURE})?`)
const DATE_PREFIX = /^\d{4}\s*[-年.\/]\s*\d{1,2}(?:\s*[-月.\/]\s*\d{1,2})?\s*日?/
const FREQUENCY_PREFIX = /^(?:每年|每月|每季度|每周|每天|每日|每\s*\d+\s*(?:个|天|周|月|年))/
const LEADING_QUANTITY = new RegExp(`^[+-]?\\d+(?:\\.\\d+)?\\s*(${MEASURE})(.*)$`, 's')
/* 公式记号：出现运算符且带数字，基本可以判定是算式而不是名称 */
const FORMULA = /[×÷\/=＝+<>＜＞≤≥]/u
/* 时长/期限写法：出生后 24 小时内、接到通知后 72 小时内 */
const DURATION = /\d+\s*(?:小时|分钟|天|日|周|个月|月|年)\s*(?:内|以内|之内|以后|以前|后|前)/

export function isValueLike(text: string | null | undefined): boolean {
  const value = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!value) return true

  // 公式优先：运算符 + 数字（「收缩压＜140mmHg 和舒张压＜90mmHg」也是算式，不是名称）
  if (/\d/.test(value) && FORMULA.test(value)) return true

  // 人口/指标口径写法：带「人数、率、比例」等统计词，是名称不是值
  if (NAMED_STATISTIC.test(value) && /\d/.test(value) && /岁以上|岁以下|及以上|及以下|~|-|～/.test(value)) return false
  // 百分比、比例单独出现
  if (/\d/.test(value) && /%\s*(?:以上|以下|左右|以内)?$|‰/.test(value)) return true
  // 纯数值（可带量词与「以上/以下」）
  if (PURE_NUMBER.test(value)) return true
  // 区间
  if (NUMBER_RANGE.test(value)) return true
  // 日期
  if (DATE_PREFIX.test(value)) return true
  // 频次短语
  if (FREQUENCY_PREFIX.test(value)) return true
  // 时长 / 期限
  if (DURATION.test(value)) return true
  // 一次性的长从句（资格说明、动作清单）：没有哪个可复用实体名会写到 40 个字
  if (value.length >= 40) return true
  // 四项以上并列的清单（男、女、未说明的性别及未知的性别），是取值不是实体
  if ((value.match(/、/g) ?? []).length >= 3) return true

  // 以「数量 + 量词」开头、后面接的是普通内容（1次健康知识讲座、12 种内容）
  const quantity = LEADING_QUANTITY.exec(value)
  if (quantity) {
    const unit = quantity[1] ?? ''
    const tail = (quantity[2] ?? '').trim()
    // 「3 级高血压」「2 型糖尿病」是分级的名称，不是值
    if (/级|型|期/.test(unit) && tail) return false
    if (!tail) return true
    // 尾巴里出现统计口径名词，说明是「0～6岁儿童」「65 岁及以上患者」这类人群名
    if (NAMED_STATISTIC.test(tail)) return false
    return true
  }
  return false
}

/** 句子里出现的年份；用于把「2025年目标」和「2030年目标」分成两个口径，避免互相取代。 */
export function yearsIn(text: string | null | undefined): string[] {
  return [...String(text ?? '').matchAll(/20\d{2}/g)].map((match) => match[0]).sort()
}

/** 谓语去掉情态词与尾巴上的虚词，用来判断两种说法是不是同一条关系。 */
export function predicateStem(predicate: string | null | undefined): string {
  return String(predicate ?? '')
    .replace(/\s+/g, '')
    .replace(/^(?:应当|应|须|需|必须|必须|宜|要|应该)/, '')
    .replace(/(?:资格|资质)$/, '')
    .replace(/[了着的]+$/, '')
}
