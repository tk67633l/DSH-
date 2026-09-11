/**
 * dsh-balance-bubble —— host 半体
 * ---------------------------------------------------------------------------
 * 在 DSH Web 界面上注入一只「DeepSeek 余额」对话气泡挂件：
 *
 *   GET  /dsh-balance-bubble/widget.js      挂件脚本（tapIndex 注入 index.html）
 *   GET  /dsh-balance-bubble/balance.json   余额 + 今日已用 + 当前模型 + 峰谷定价
 *   POST /dsh-balance-bubble/model.json     前端上报当前模型（可选提示）
 *   GET  /dsh-balance-bubble/art.png|.svg   角色立绘（含参考原型图）
 *   GET  /dsh-balance-bubble/sound/click.wav 点击音效（上传音频转码后的 WAV）
 *
 * 凭据只在本进程内使用：
 *   DEEPSEEK_API_KEY          → api.deepseek.com/user/balance（余额）
 *   DEEPSEEK_PLATFORM_TOKEN   → platform.deepseek.com 用量接口（今日已用，可选）
 * 没有 platform token 时，「今日已用」用余额差分估算（≈）。
 *
 * 「当前模型」的取得顺序：
 *   1. 本进程监听到的会话事件里的 request/header.config（最准，模型随会话切换即时更新）；
 *   2. 会话投影 modelSelection（pending / lastUsed）；
 *   3. agentDefaultModel 的当前默认选择；
 *   4. 前端上报的 model.json 提示。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pricingSnapshot } from './pricing.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const name = 'balance-bubble'
const inject = ['webServer', 'credentials']

/** 路由前缀（与 widget.js 内的 BASE 保持一致）。 */
const BASE = '/dsh-balance-bubble'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/cost'
const BALANCE_TTL_MS = 20_000
const USAGE_TTL_MS = 60_000
const FETCH_TIMEOUT_MS = 20_000

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
}

/** 静态资源候选路径（package 优先，兼容 DSH_HOME 下的落地副本）。 */
const ASSETS = {
  'character.png': ['assets/character.png'],
  'reference.png': ['assets/reference.png'],
  'sound/click.wav': ['assets/click.wav'],
  'sound/click.mp4': ['assets/click.mp4'],
}

const MIME = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
}

// ------------------------------------------------------------------ utilities

function sendJSON(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 本地日期 YYYY-MM-DD（平台用量接口按本地日历日切分）。 */
function localDate(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

function clampError(error, limit = 200) {
  return String((error && error.message) || error).slice(0, limit)
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ------------------------------------------------------------------ state file

/** 今日已用（估算）状态文件：$DSH_HOME/storages/balance-bubble-day.json */
function usageStatePath() {
  return path.join(DSH_HOME, 'storages', 'balance-bubble-day.json')
}

function readUsageState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageStatePath(), 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.date === 'string' &&
      typeof parsed.opening === 'number' &&
      typeof parsed.last === 'number'
    ) {
      return parsed
    }
  } catch (err) {}
  return null
}

function writeUsageState(state) {
  try {
    const file = usageStatePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {}
}

// ---------------------------------------------------------------------- apply

function apply(ctx) {
  const disposers = []
  let modelHint = ''
  let liveModels = new Map() // sessionId -> { model, provider, at }
  let lastLive = null // { model, provider, at }

  let balanceCache = null // { at, balance, currency, isAvailable }
  let usageCache = null // { at, value, source }
  let deriveCache = null // { at, value }
  let inFlight = null

  // ---- 当前模型：监听会话事件流 -------------------------------------------
  // request/header 携带真正发给 provider 的 provider/model；session/event 是
  // 全局事件，字段形状随版本变化，这里全部做防御式提取。
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'request/header') return
      const config = event.data && event.data.header && event.data.header.config
      if (!config || typeof config.model !== 'string') return
      const entry = { model: config.model, provider: config.provider, at: Date.now() }
      liveModels.set(session && session.id ? session.id : 'default', entry)
      lastLive = entry
      if (liveModels.size > 64) {
        const oldest = [...liveModels.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) liveModels.delete(oldest[0])
      }
    } catch (err) {}
  })

  /** 读取某个已挂载会话的模型选择（不激活会话，不产生副作用）。 */
  function modelFromSession(session) {
    if (!session) return null
    try {
      const state = ctx.sessionProjections && ctx.sessionProjections.stateOf
        ? ctx.sessionProjections.stateOf(session, 'modelSelection')
        : undefined
      if (state) {
        const pick = state.pending || state.lastUsed
        if (pick && typeof pick.model === 'string') return pick.model
      }
    } catch (err) {}
    try {
      if (typeof session.requestHeader === 'function') {
        const header = session.requestHeader()
        const config = header && header.config
        if (config && typeof config.model === 'string') return config.model
      }
    } catch (err) {}
    return null
  }

  /** 当前模型解析：实时事件 → 最活跃会话 → 默认模型 → 前端提示。 */
  function resolveModel() {
    if (lastLive && Date.now() - lastLive.at < 6 * 60 * 60 * 1000) return lastLive.model
    try {
      const sessions = ctx.sessions
      if (sessions && typeof sessions.values === 'function') {
        let best = null
        for (const session of sessions.values()) {
          if (!session) continue
          const seq = Number(session.seq) || 0
          if (!best || seq > best.seq) best = { session, seq }
        }
        const picked = best ? modelFromSession(best.session) : null
        if (picked) return picked
      }
    } catch (err) {}
    try {
      const fallback = ctx.agentDefaultModel && ctx.agentDefaultModel.currentSelection
        ? ctx.agentDefaultModel.currentSelection()
        : null
      if (fallback && typeof fallback.model === 'string') return fallback.model
    } catch (err) {}
    return modelHint || ''
  }

  // ---- 余额 ---------------------------------------------------------------
  async function fetchBalance() {
    let cred
    try {
      cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
    } catch (err) {
      return { ok: false, code: 'NO_KEY', error: '凭据读取失败：' + clampError(err, 120) }
    }
    if (!cred || !cred.value) {
      return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY（设置 → 模型 中填写）' }
    }

    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
      try {
        res = await fetch(BALANCE_URL, {
          headers: { Authorization: 'Bearer ' + cred.value, Accept: 'application/json' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400))
        continue
      }
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status)
        if (res.status < 500) break
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400))
        continue
      }
      let data
      try {
        data = await res.json()
      } catch (err) {
        return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
      }
      const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
      if (infos.length === 0) {
        return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
      }
      const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
      const info =
        infos.find((x) => x && x.currency === 'CNY' && isFinite(num(x))) ||
        infos.find((x) => isFinite(num(x))) ||
        infos[0]
      return {
        ok: true,
        totalBalance: num(info),
        currency: String((info && info.currency) || 'CNY'),
        isAvailable: data && data.is_available !== false,
        updatedAt: new Date().toISOString(),
      }
    }
    return {
      ok: false,
      code: 'HTTP',
      transient: !(lastErr && /^HTTP 4\d\d/.test(lastErr.message)),
      error: '余额接口请求失败：' + clampError(lastErr),
    }
  }

  async function getBalance() {
    const now = Date.now()
    if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.payload
    if (inFlight) return inFlight
    inFlight = fetchBalance()
      .then((payload) => {
        if (payload.ok) {
          balanceCache = { at: Date.now(), payload }
          return payload
        }
        if (payload.transient && balanceCache) {
          return { ...balanceCache.payload, stale: true, error: payload.error }
        }
        return payload
      })
      .catch((err) => ({ ok: false, code: 'ERROR', error: '余额服务异常：' + clampError(err, 120) }))
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  // ---- 今日已用 -----------------------------------------------------------
  /** 官方口径：platform.deepseek.com 的当月消费接口，取今天那一行。 */
  async function fetchPlatformTodayCost(token) {
    const now = new Date()
    const url = `${PLATFORM_USAGE_URL}?month=${now.getMonth() + 1}&year=${now.getFullYear()}`
    const res = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + String(token).replace(/^Bearer\s+/i, ''),
        Accept: 'application/json',
        Origin: 'https://platform.deepseek.com',
        Referer: 'https://platform.deepseek.com/usage',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const body = await res.json()
    const data = body && body.data
    if (!body || body.code !== 0 || !data || data.biz_code !== 0) {
      throw new Error('平台接口错误 code ' + String((body && body.code) ?? (data && data.biz_code) ?? '?'))
    }
    const container = Array.isArray(data.biz_data) ? data.biz_data[0] : data.biz_data
    const days = container && container.days
    if (!Array.isArray(days)) return null
    const today = localDate(now)
    const entry = days.find((row) => row && row.date === today)
    if (!entry || !Array.isArray(entry.data)) return null
    let total = 0
    for (const modelEntry of entry.data) {
      if (!modelEntry || !Array.isArray(modelEntry.usage)) continue
      for (const item of modelEntry.usage) {
        if (!item) continue
        const value = toFinite(item.cost !== undefined ? item.cost : item.amount)
        if (isFinite(value)) total += value
      }
    }
    return Math.round(total * 100) / 100
  }

  /** 估算口径：记录当日开盘余额，用「开盘 − 当前」得到今日消耗。 */
  function estimateTodayUsage(balance) {
    if (!isFinite(balance)) return null
    const today = localDate()
    const stored = readUsageState()
    const opening = stored && stored.date === today ? stored.opening : stored ? stored.last : balance
    writeUsageState({ date: today, opening, last: balance, updatedAt: new Date().toISOString() })
    return Math.round(Math.max(0, opening - balance) * 100) / 100
  }

  async function getTodayUsage(balance) {
    const now = Date.now()
    if (usageCache && now - usageCache.at < USAGE_TTL_MS) return usageCache
    let cred = null
    try {
      cred = await ctx.credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
    } catch (err) {
      cred = null
    }
    if (cred && cred.value) {
      try {
        const official = await fetchPlatformTodayCost(cred.value)
        if (official !== null) {
          usageCache = { at: now, value: official, source: 'official' }
          return usageCache
        }
      } catch (err) {
        ctx.logger?.warn?.('balance-bubble: 平台用量接口不可用，回退余额差分估算')
      }
    }
    if (!deriveCache || now - deriveCache.at > 2000) {
      deriveCache = { at: now, value: estimateTodayUsage(balance) }
    }
    usageCache = { at: now, value: deriveCache.value, source: 'estimate' }
    return usageCache
  }

  // ---- 静态资源 -----------------------------------------------------------
  function resolveAsset(relative) {
    for (const candidate of ASSETS[relative] || []) {
      const file = path.join(PACKAGE_ROOT, candidate)
      try {
        const bytes = fs.readFileSync(file)
        if (bytes && bytes.length > 0) return { bytes, file }
      } catch (err) {}
    }
    return null
  }

  function serveAsset(req, res, relative) {
    const hit = resolveAsset(relative)
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('asset unavailable: ' + relative)
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(relative)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': String(hit.bytes.length),
    })
    res.end(hit.bytes)
  }

  // ---- 路由 ---------------------------------------------------------------
  function route(routePath, handler) {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler,
      })
    )
  }

  route(BASE + '/widget.js', (req, res) => {
    let body = ''
    try {
      body = fs.readFileSync(path.join(HERE, 'widget.js'), 'utf8')
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('widget.js unavailable: ' + clampError(err))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  })

  /** 立绘（透明背景人物图）内联成 data URI：挂件无需额外请求即可显示。 */
  function characterDataUri() {
    const hit = resolveAsset('character.png')
    if (!hit) return ''
    return 'data:image/png;base64,' + hit.bytes.toString('base64')
  }

  route(BASE + '/balance.json', async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const hint = url.searchParams.get('model')
      if (hint && hint.length < 128) modelHint = hint
      const balance = await getBalance()
      const model = resolveModel()
      const pricing = pricingSnapshot(Date.now(), { model })
      let todayUsage = null
      let todayUsageSource = 'estimate'
      if (balance.ok) {
        const usage = await getTodayUsage(balance.totalBalance)
        todayUsage = usage ? usage.value : null
        todayUsageSource = usage ? usage.source : 'estimate'
      }
      sendJSON(res, 200, {
        ok: balance.ok,
        error: balance.error,
        code: balance.code,
        stale: balance.stale === true,
        totalBalance: balance.totalBalance,
        currency: balance.currency || 'CNY',
        isAvailable: balance.isAvailable,
        todayUsage,
        todayUsageSource,
        model,
        modelSource: lastLive ? 'session' : hint ? 'client' : 'default',
        pricing,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      sendJSON(res, 200, { ok: false, code: 'ERROR', error: clampError(err) })
    }
  })

  route(BASE + '/model.json', async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'PUT') {
      sendJSON(res, 200, { ok: true, model: resolveModel() })
      return
    }
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}')
      if (parsed && typeof parsed.model === 'string' && parsed.model.length > 0 && parsed.model.length < 128) {
        modelHint = parsed.model
        balanceCache = null
        usageCache = null
      }
      sendJSON(res, 200, { ok: true, model: resolveModel() })
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: clampError(err) })
    }
  })

  for (const relative of Object.keys(ASSETS)) {
    route(BASE + '/' + relative, (req, res) => serveAsset(req, res, relative))
  }

  // ---- 注入 index.html ----------------------------------------------------
  // 顺序很关键：先给挂件配置，再给立绘 data URI，最后才加载挂件脚本。
  // 立绘内联成 data URI（约 130KB）省掉一次请求，也不受 CSP 资源策略影响。
  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string' || html.indexOf(BASE + '/widget.js') !== -1) return html
      const config =
        '<script>window.__DSH_BALANCE_BUBBLE__=' +
        JSON.stringify({ base: BASE, version: '0.1.1' }) +
        ';</script>'
      const character = characterDataUri()
      const art = character
        ? '<script>window.__DSH_BALANCE_BUBBLE_ART__=' + JSON.stringify(character) + ';</script>'
        : ''
      const tag = config + art + '<script defer src="' + BASE + '/widget.js?v=0.1.1"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    })
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {}
    }
  })
}

export { name, inject, apply }
