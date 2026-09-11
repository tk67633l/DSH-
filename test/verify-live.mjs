/**
 * 端到端校验：把插件宿主半体挂到一个真的 node:http 服务上，跑一遍挂件真实请求流程。
 *
 *   node test/verify-live.mjs                       # 默认用已安装副本
 *   node test/verify-live.mjs --local               # 用本仓库 lib/index.js
 *   node test/verify-live.mjs --offline             # 跳过真实余额接口（只校验路由与资源）
 *
 * 覆盖：index.html 注入（含立绘 data URI）→ widget.js → character.png →
 *       reference.png → sound/click.wav → balance.json（联网时调真实 DeepSeek 余额接口，
 *       用 $DSH_HOME/.credentials.yaml 里的 DEEPSEEK_API_KEY，key 只在本进程内存中使用）。
 *
 * 这是唯一会访问网络的测试；`npm test` 不包含它。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const args = process.argv.slice(2)
const OFFLINE = args.includes('--offline')
const USE_LOCAL = args.includes('--local')

// 优先使用“已安装副本”（最贴近线上），否则回退到本仓库
const candidates = USE_LOCAL
  ? [REPO_ROOT]
  : [path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-balance-bubble'), REPO_ROOT]

let PLUGIN_DIR = null
for (const dir of candidates) {
  if (fs.existsSync(path.join(dir, 'lib', 'index.js'))) {
    PLUGIN_DIR = dir
    break
  }
}
if (PLUGIN_DIR === null) {
  console.error('找不到插件：' + candidates.join(' 或 '))
  process.exit(2)
}

const { apply, name } = await import(
  'file:///' + path.join(PLUGIN_DIR, 'lib', 'index.js').replace(/\\/g, '/')
)
console.log('loaded plugin:', name, 'from', PLUGIN_DIR)

// ---- 读取真实 API Key（仅本进程内使用，不打印） ---------------------------
function readApiKey() {
  for (const file of [path.join(HOME, '.credentials.yaml'), path.join(HOME, 'credentials.yaml')]) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const match = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text)
      if (match) return match[1]
    } catch (err) {}
  }
  return ''
}
const apiKey = OFFLINE ? '' : readApiKey()
console.log(
  'api key:',
  OFFLINE ? '(offline 模式跳过)' : apiKey ? 'found in ' + path.join(HOME, '.credentials.yaml') : 'NOT FOUND'
)

// ---- 桩 ctx：真路由表 + 真 HTTP 服务 -------------------------------------
const exact = new Map()
const taps = []
const ctx = {
  logger: { warn() {}, error() {}, info() {} },
  credentials: {
    async resolve(ref) {
      const key = typeof ref === 'string' ? ref : ref && ref.key
      if (key === 'DEEPSEEK_API_KEY' && apiKey) return { value: apiKey }
      return undefined
    },
  },
  sessions: new Map(),
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  sessionProjections: { stateOf: () => undefined },
  on() {
    return () => {}
  },
  effect(fn) {
    fn()
  },
  webServer: {
    register(route) {
      if (exact.has(route.path)) throw new Error('duplicate route ' + route.path)
      exact.set(route.path, route)
      return () => exact.delete(route.path)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
}

apply(ctx)
console.log('routes:', [...exact.keys()].join(', '))

const server = http.createServer(async (req, res) => {
  const route = exact.get(new URL(req.url, 'http://x').pathname)
  if (!route) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  try {
    await route.handler(req, res)
  } catch (error) {
    res.writeHead(500)
    res.end(String((error && error.stack) || error))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
console.log('server:', base)

async function probe(label, url, expectType) {
  try {
    const res = await fetch(base + url)
    const type = res.headers.get('content-type') || ''
    const bytes = Buffer.from(await res.arrayBuffer())
    const ok = res.ok && (!expectType || type.includes(expectType)) && bytes.length > 0
    console.log((ok ? '  ok   ' : '  FAIL ') + label + '  →  ' + res.status + ' ' + type + ' ' + bytes.length + 'B')
    if (!ok) process.exitCode = 1
    return bytes
  } catch (error) {
    console.log('  FAIL ' + label + '  →  ' + ((error && error.message) || error))
    process.exitCode = 1
    return Buffer.alloc(0)
  }
}

console.log('\n[injected index.html]')
const html = taps[0]('<html><head></head><body><div id="root"></div></body></html>')
const injected = /__DSH_BALANCE_BUBBLE__/.test(html) && /\/dsh-balance-bubble\/widget\.js/.test(html)
console.log((injected ? '  ok   ' : '  FAIL ') + 'index.html 注入配置与脚本')
if (!injected) process.exitCode = 1

const artMatch = /__DSH_BALANCE_BUBBLE_ART__="data:image\/png;base64,([^"]*)"/.exec(html)
const artOk = !!artMatch && html.indexOf('__DSH_BALANCE_BUBBLE_ART__') < html.indexOf('/dsh-balance-bubble/widget.js')
console.log((artOk ? '  ok   ' : '  FAIL ') + '人物立绘 data URI 已内联且早于脚本')
if (artMatch) {
  console.log('  立绘 base64 ' + artMatch[1].length + ' 字符（≈' + ((artMatch[1].length * 3) / 4 / 1024).toFixed(0) + 'KB PNG）')
}
if (!artOk) process.exitCode = 1

console.log('\n[static assets]')
await probe('widget.js', '/dsh-balance-bubble/widget.js', 'javascript')
await probe('character.png', '/dsh-balance-bubble/character.png', 'image/png')
await probe('reference.png', '/dsh-balance-bubble/reference.png', 'image/png')
await probe('sound/click.wav', '/dsh-balance-bubble/sound/click.wav', 'audio/wav')

console.log('\n[data]')
const bytes = await probe('balance.json', '/dsh-balance-bubble/balance.json', 'json')
try {
  const body = JSON.parse(bytes.toString('utf8'))
  console.log(
    '  payload: ' +
      JSON.stringify({
        ok: body.ok,
        error: body.error,
        totalBalance: body.totalBalance,
        currency: body.currency,
        todayUsage: body.todayUsage,
        todayUsageSource: body.todayUsageSource,
        model: body.model,
        mode: body.pricing && body.pricing.mode,
        label: body.pricing && body.pricing.label,
        peak: body.pricing && body.pricing.peak,
        unit: body.pricing && body.pricing.unit,
        nextSwitch: body.pricing && body.pricing.nextSwitch,
      })
  )
  if (!body.pricing || !body.pricing.unit) process.exitCode = 1
  // 离线模式下没有凭据，ok=false 属预期；联网模式必须有余额
  if (!OFFLINE && !body.ok) process.exitCode = 1
  if (OFFLINE && body.code !== 'NO_KEY' && body.ok) console.log('  提示：offline 模式仍拿到了余额（说明本机凭据被解析了）')
} catch (error) {
  console.log('  FAIL 解析 balance.json: ' + ((error && error.message) || error))
  process.exitCode = 1
}

server.close()
console.log('\n' + (process.exitCode ? 'VERIFY FAILED' : 'VERIFY OK'))
