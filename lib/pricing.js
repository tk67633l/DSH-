/**
 * DeepSeek 官方价格引擎（纯函数、零依赖）。
 *
 * 语义与官方文档 / provider 适配器一致：
 *   input      缓存未命中输入
 *   cacheRead  缓存命中输入
 *   output     输出
 * 单价单位：每 1M tokens，人民币。
 *
 * 峰谷规则（北京时间 Asia/Shanghai）：
 *   高峰：周一至周五 09:00-12:00、14:00-18:00（[start, end) 闭开区间）
 *   其余：空闲（含周六、周日全天）
 *
 * 生效时间表（新政策靠后追加，`since` 最晚且不晚于目标时刻的政策胜出）：
 *   2025-02-09  deepseek-chat / deepseek-reasoner 标准价
 *   2026-05-22  V4 系列 75% 降价永久化（v4-flash / v4-pro 上线）
 *   2026-08-17  V4 系列峰谷定价（高峰 3/0.1/9，空闲半价）
 *   2026-09-10 12:00  flash 系列二次降价：空闲 1/0.02/4，高峰 2/0.04/8
 *
 * 未在最新政策点名的模型（例如 deepseek-v4-pro）沿用最近一次点名它的政策价，
 * 这样历史账单与平台一致；完全没有点名时用该政策的兜底档（"*"）。
 *
 * 官方价格页：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 */

/** 峰谷判定的时区。 */
export const TIMEZONE = 'Asia/Shanghai'

/** 高峰时段（本地小时，[start, end)），仅工作日生效。 */
export const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
]

/** 价格周期展示文案。 */
export const MODE_LABELS = { peak: '高峰', offPeak: '空闲', flat: '常规' }

const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 })

/**
 * 官方政策时间表。每条政策要么是固定单价表（prices），要么是峰谷单价表
 * （peak / offPeak）；表内按模型名给出 `{ input, cacheRead, output }`（元/百万 token），
 * `"*"` 为该政策的兜底档。
 */
export const POLICIES = [
  {
    since: '2025-02-09T00:00:00+08:00',
    label: 'deepseek-chat / deepseek-reasoner 标准价',
    prices: {
      'deepseek-chat': { input: 2, cacheRead: 0.5, output: 8 },
      'deepseek-reasoner': { input: 4, cacheRead: 1, output: 16 },
      '*': { input: 2, cacheRead: 0.5, output: 8 },
    },
  },
  {
    since: '2026-05-22T00:00:00+08:00',
    label: 'V4 系列 75% 降价转永久',
    prices: {
      'deepseek-v4-flash': { input: 1, cacheRead: 0.02, output: 2 },
      'deepseek-v4-pro': { input: 3, cacheRead: 0.025, output: 6 },
      '*': { input: 1, cacheRead: 0.02, output: 2 },
    },
  },
  {
    since: '2026-08-17T00:00:00+08:00',
    label: 'V4 系列启用峰谷定价',
    peak: {
      'deepseek-v4-flash': { input: 3, cacheRead: 0.1, output: 9 },
      'deepseek-v4-pro': { input: 9, cacheRead: 0.3, output: 27 },
      '*': { input: 3, cacheRead: 0.1, output: 9 },
    },
    offPeak: {
      'deepseek-v4-flash': { input: 1.5, cacheRead: 0.05, output: 4.5 },
      'deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, output: 13.5 },
      '*': { input: 1.5, cacheRead: 0.05, output: 4.5 },
    },
  },
  {
    since: '2026-09-10T12:00:00+08:00',
    label: 'flash 系列峰谷新价（缓存命中直降 60%）',
    peak: {
      'deepseek-v4-flash': { input: 2, cacheRead: 0.04, output: 8 },
      'deepseek-v4-flash-vision-exp': { input: 2, cacheRead: 0.04, output: 8 },
      '*': { input: 2, cacheRead: 0.04, output: 8 },
    },
    offPeak: {
      'deepseek-v4-flash': { input: 1, cacheRead: 0.02, output: 4 },
      'deepseek-v4-flash-vision-exp': { input: 1, cacheRead: 0.02, output: 4 },
      '*': { input: 1, cacheRead: 0.02, output: 4 },
    },
  },
]

/**
 * 该时刻生效的政策（`since` 不晚于该时刻的最后一条；早于首条时取首条）。
 * @param timeMs - epoch 毫秒。
 * @param policies - 政策表，默认官方表。
 */
export function activePolicy(timeMs, policies = POLICIES) {
  let active = policies[0]
  for (const policy of policies) {
    const since = Date.parse(policy.since)
    if (Number.isFinite(since) && timeMs >= since) active = policy
  }
  return active
}

/** 该时刻在给定时区是否为周六/周日。 */
export function isWeekend(timeMs, timezone = TIMEZONE) {
  try {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(new Date(timeMs))
    return weekday === 'Sat' || weekday === 'Sun'
  } catch {
    return false
  }
}

/** 该时刻的时区本地小时（0-23）。 */
export function hourIn(timeMs, timezone = TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(timeMs))
    return Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24
  } catch {
    return -1
  }
}

/** 该时刻是否处于高峰时段（周末与窗口外均为空闲）。 */
export function isPeak(timeMs, timezone = TIMEZONE, windows = PEAK_WINDOWS) {
  if (isWeekend(timeMs, timezone)) return false
  const hour = hourIn(timeMs, timezone)
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** 该时刻所属的价格周期（有峰谷政策时为 peak / offPeak，否则 flat）。 */
export function periodMode(timeMs, policies = POLICIES, timezone = TIMEZONE, windows = PEAK_WINDOWS) {
  const policy = activePolicy(timeMs, policies)
  if (policy.peak === undefined || policy.offPeak === undefined) return 'flat'
  return isPeak(timeMs, timezone, windows) ? 'peak' : 'offPeak'
}

/** 政策在给定周期下的单价表。 */
function tableFor(policy, peak) {
  return policy.peak !== undefined && policy.offPeak !== undefined ? (peak ? policy.peak : policy.offPeak) : policy.prices
}

/**
 * 某模型在某时刻的单价。
 *
 * 解析顺序（政策链继承）：
 *   1. 从新到旧遍历不晚于该时刻的政策，取第一个点名该模型的政策；
 *   2. 没有任何政策点名 → 用最新适用政策的兜底档（"*"）。
 * @returns `{ unit, mode, peak, policy }`，unit 为 `{ input, cacheRead, output }`（元/百万 token）。
 */
export function priceAt(model, timeMs, options = {}) {
  const { policies = POLICIES, timezone = TIMEZONE, windows = PEAK_WINDOWS } = options
  const peak = isPeak(timeMs, timezone, windows)
  const applicable = policies.filter((policy) => timeMs >= Date.parse(policy.since))
  const scope = applicable.length > 0 ? applicable : [policies[0]]
  let winner
  let unit
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index]
    const table = tableFor(policy, peak)
    if (table[model] !== undefined) {
      winner = policy
      unit = table[model]
      break
    }
  }
  if (winner === undefined) {
    winner = scope[scope.length - 1]
    const table = tableFor(winner, peak)
    unit = table['*'] ?? ZERO_UNIT
  }
  const peakCapable = winner.peak !== undefined && winner.offPeak !== undefined
  return {
    unit,
    peak,
    mode: peakCapable ? (peak ? 'peak' : 'offPeak') : 'flat',
    policy: { since: winner.since, label: winner.label },
  }
}

/**
 * 把某个时刻的峰谷状态整理成前端徽标/文案需要的结构。
 * @param timeMs - epoch 毫秒；缺省为当前时间。
 * @param options - `{ model, policies, timezone, windows }`。
 * @returns `{ mode, label, peak, weekend, hour, timezone, windows, model, unit, policy, nextSwitch }`。
 */
export function pricingSnapshot(timeMs = Date.now(), options = {}) {
  const { model = '', policies = POLICIES, timezone = TIMEZONE, windows = PEAK_WINDOWS } = options
  const at = priceAt(model, timeMs, { policies, timezone, windows })
  const weekend = isWeekend(timeMs, timezone)
  return {
    mode: at.mode,
    label: MODE_LABELS[at.mode] ?? at.mode,
    peak: at.peak,
    weekend,
    hour: hourIn(timeMs, timezone),
    timezone,
    windows,
    model,
    unit: at.unit,
    policy: at.policy,
    nextSwitch: nextSwitch(timeMs, { policies, timezone, windows }),
  }
}

/**
 * 下一次峰谷切换的时间点（用于「距下次切换 1小时20分」提示）。
 * 逐分钟向前扫描，最多 8 天；找不到（例如无峰谷政策）时返回 null。
 * @returns `{ at, mode, inMinutes }` 或 null。
 */
export function nextSwitch(timeMs, options = {}) {
  const { policies = POLICIES, timezone = TIMEZONE, windows = PEAK_WINDOWS } = options
  const policy = activePolicy(timeMs, policies)
  if (policy.peak === undefined || policy.offPeak === undefined) return null
  const current = isPeak(timeMs, timezone, windows)
  const limit = 8 * 24 * 60
  for (let step = 1; step <= limit; step++) {
    const candidate = timeMs + step * 60_000
    if (isPeak(candidate, timezone, windows) !== current) {
      return { at: candidate, mode: current ? 'offPeak' : 'peak', inMinutes: step }
    }
  }
  return null
}
