/**
 * dsh-balance-bubble 自检：定价引擎 + host 路由 + 前端脚本资产。
 *
 *   node test/selftest.mjs
 *
 * 全部用例顺序 await 执行；不访问网络（凭据解析返回空 → 走错误分支）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name, inject } from '../lib/index.js'
import { activePolicy, isPeak, isWeekend, priceAt, pricingSnapshot, nextSwitch } from '../lib/pricing.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const beijing = (iso) => Date.parse(iso)

const checks = []
const test = (label, fn) => checks.push([label, fn])
const group = (title) => checks.push([null, () => console.log('\n[' + title + ']')])

let passed = 0
async function runAll() {
  for (const [label, fn] of checks) {
    if (label === null) {
      await fn()
      continue
    }
    try {
      await fn()
      passed++
      console.log('  ok   ' + label)
    } catch (error) {
      console.error('  FAIL ' + label + '\n       ' + ((error && error.message) || error))
      process.exitCode = 1
    }
  }
  console.log('\n' + (process.exitCode ? 'SELFTEST FAILED' : 'SELFTEST OK (' + passed + ' checks)'))
}

// --------------------------------------------------------------------- pricing
group('pricing')

test('北京时间工作日 10:00 为高峰', () => {
  assert.equal(isPeak(beijing('2026-09-11T10:00:00+08:00')), true)
})
test('北京时间工作日 12:00 起为谷期（[9,12) 闭开区间）', () => {
  assert.equal(isPeak(beijing('2026-09-11T12:00:00+08:00')), false)
})
test('北京时间工作日 15:00 为高峰', () => {
  assert.equal(isPeak(beijing('2026-09-11T15:00:00+08:00')), true)
})
test('北京时间工作日 20:00 为谷期', () => {
  assert.equal(isPeak(beijing('2026-09-11T20:00:00+08:00')), false)
})
test('周六、周日全天为谷期', () => {
  assert.equal(isWeekend(beijing('2026-09-12T10:00:00+08:00')), true)
  assert.equal(isPeak(beijing('2026-09-12T10:00:00+08:00')), false)
  assert.equal(isPeak(beijing('2026-09-13T15:00:00+08:00')), false)
})
test('2026-09-10 12:00 之前 flash 用 8-17 政策价（高峰 3/0.1/9）', () => {
  const at = priceAt('deepseek-v4-flash', beijing('2026-09-10T10:00:00+08:00'))
  assert.deepEqual(at.unit, { input: 3, cacheRead: 0.1, output: 9 })
})
test('新政策生效后 flash 高峰 2/0.04/8', () => {
  const at = priceAt('deepseek-v4-flash', beijing('2026-09-10T14:00:00+08:00'))
  assert.deepEqual(at.unit, { input: 2, cacheRead: 0.04, output: 8 })
})
test('新政策生效后 flash 谷期 1/0.02/4', () => {
  const at = priceAt('deepseek-v4-flash', beijing('2026-09-10T20:00:00+08:00'))
  assert.deepEqual(at.unit, { input: 1, cacheRead: 0.02, output: 4 })
})
test('flash 视觉版与 flash 同价', () => {
  const a = priceAt('deepseek-v4-flash', beijing('2026-09-11T10:00:00+08:00'))
  const b = priceAt('deepseek-v4-flash-vision-exp', beijing('2026-09-11T10:00:00+08:00'))
  assert.deepEqual(a.unit, b.unit)
})
test('v4-pro 未被新政策点名 → 沿用 8-17 峰谷价（高峰 9/0.3/27）', () => {
  const at = priceAt('deepseek-v4-pro', beijing('2026-09-11T10:00:00+08:00'))
  assert.deepEqual(at.unit, { input: 9, cacheRead: 0.3, output: 27 })
})
test('别名 deepseek-flash 命中 flash 档位', () => {
  const at = priceAt('deepseek-flash', beijing('2026-09-11T20:00:00+08:00'))
  assert.deepEqual(at.unit, { input: 1, cacheRead: 0.02, output: 4 })
})
test('未知模型走兜底档而不是报错', () => {
  const at = priceAt('some-unknown-model', beijing('2026-09-11T20:00:00+08:00'))
  assert.equal(at.unit.input, 1)
})
test('2026-06 的请求按当时政策计价（历史一致）', () => {
  const at = priceAt('deepseek-v4-flash', beijing('2026-06-01T10:00:00+08:00'))
  assert.equal(at.mode, 'flat')
  assert.deepEqual(at.unit, { input: 1, cacheRead: 0.02, output: 2 })
})
test('activePolicy 取生效时间最晚的一条', () => {
  assert.equal(activePolicy(beijing('2026-09-11T10:00:00+08:00')).since, '2026-09-10T12:00:00+08:00')
  assert.equal(activePolicy(beijing('2026-08-20T10:00:00+08:00')).since, '2026-08-17T00:00:00+08:00')
})
test('pricingSnapshot 给出周期、模型、单价与下次切换', () => {
  const snap = pricingSnapshot(beijing('2026-09-11T11:30:00+08:00'), { model: 'deepseek-v4-flash' })
  assert.equal(snap.mode, 'peak')
  assert.equal(snap.label, '高峰')
  assert.equal(snap.model, 'deepseek-v4-flash')
  assert.equal(snap.nextSwitch.mode, 'offPeak')
  assert.equal(snap.nextSwitch.inMinutes, 30)
})
test('谷期中下次切换指向高峰', () => {
  const next = nextSwitch(beijing('2026-09-11T12:30:00+08:00'))
  assert.equal(next.mode, 'peak')
  assert.equal(next.inMinutes, 90)
})
test('周末的下一次切换落在下周一 09:00', () => {
  const next = nextSwitch(beijing('2026-09-12T10:00:00+08:00'))
  assert.equal(next.mode, 'peak')
  assert.equal(new Date(next.at).toISOString(), '2026-09-14T01:00:00.000Z')
})

// ---------------------------------------------------------------------- assets
group('assets')

test('人物立绘存在，且是带透明通道的 PNG（白底已抠掉）', () => {
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'character.png'))
  assert.equal(png.slice(1, 4).toString('ascii'), 'PNG')
  // PNG IHDR: 宽(16) 高(20) 位深(24) 颜色类型(25)；6=truecolor+alpha，3=调色板（可带 tRNS 透明）
  const colorType = png[25]
  assert.ok(colorType === 6 || colorType === 3, '颜色类型应为 6 或 3，实际 ' + colorType)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.ok(width >= 256 && height >= 256, `立绘尺寸过小 ${width}x${height}`)
  assert.ok(png.includes(Buffer.from('tRNS')) || colorType === 6, '缺少透明信息')
})
test('参考原型图存在', () => {
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'reference.png'))
  assert.equal(png.slice(1, 4).toString('ascii'), 'PNG')
})
test('点击音效存在（RIFF/WAVE 头，含音频数据，时长合理）', () => {
  const wav = fs.readFileSync(path.join(ROOT, 'assets', 'click.wav'))
  assert.equal(wav.slice(0, 4).toString('ascii'), 'RIFF')
  assert.equal(wav.slice(8, 12).toString('ascii'), 'WAVE')
  // 正规遍历 chunk（ffmpeg 会写 LIST 元数据块，data 不在固定偏移）
  let offset = 12
  let byteRate = 0
  let dataSize = 0
  while (offset + 8 <= wav.length) {
    const id = wav.slice(offset, offset + 4).toString('ascii')
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ') byteRate = wav.readUInt32LE(offset + 8 + 8)
    if (id === 'data') dataSize = size
    offset += 8 + size + (size % 2)
  }
  assert.ok(byteRate > 0, '未找到 fmt 块')
  assert.ok(dataSize > 50_000, '音频数据过小: ' + dataSize)
  const seconds = dataSize / byteRate
  assert.ok(seconds > 1.0 && seconds < 3.0, `音效时长应在 1-3 秒，实际 ${seconds.toFixed(2)}s`)
})
test('音效原始视频留档存在', () => {
  const mp4 = fs.readFileSync(path.join(ROOT, 'assets', 'click.mp4'))
  assert.ok(mp4.length > 100_000, 'click.mp4 过小')
  assert.equal(mp4.slice(4, 8).toString('ascii'), 'ftyp')
})
test('widget.js 不引用未定义常量，且读取注入配置', () => {
  const js = fs.readFileSync(path.join(ROOT, 'lib', 'widget.js'), 'utf8')
  assert.ok(!/CHAR_SVG/.test(js), '仍引用 CHAR_SVG')
  assert.match(js, /window\.__DSH_BALANCE_BUBBLE__/)
})
test('widget.js 峰谷展示时长为 5 秒', () => {
  const js = fs.readFileSync(path.join(ROOT, 'lib', 'widget.js'), 'utf8')
  assert.match(js, /PHASE_MS\s*=\s*5000/)
})

// ----------------------------------------------------------------- host routes
group('host routes')

function makeCtx() {
  const routes = new Map()
  const taps = []
  const events = new Map()
  const ctx = {
    logger: { warn() {}, error() {} },
    credentials: { async resolve() { return undefined } },
    sessions: new Map(),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    sessionProjections: { stateOf: () => undefined },
    on(type, handler) {
      if (!events.has(type)) events.set(type, [])
      events.get(type).push(handler)
      return () => {}
    },
    effect(fn) {
      fn()
    },
    webServer: {
      register(route) {
        assert.ok(!routes.has(route.path), 'duplicate route ' + route.path)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      tapIndex(fn) {
        taps.push(fn)
        return () => {}
      },
    },
  }
  return { ctx, routes, taps, events }
}

const fakeReq = (url, method = 'GET') => ({ url, method, on() {}, destroy() {} })

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers || null
    },
    end(body) {
      res.body = body === undefined ? '' : String(body)
    },
  }
  return res
}

const { ctx, routes, taps, events } = makeCtx()
apply(ctx)

test('导出 name / inject', () => {
  assert.equal(name, 'balance-bubble')
  assert.deepEqual(inject, ['webServer', 'credentials'])
})

test('注册了挂件脚本、余额、模型与资源路由', () => {
  for (const p of [
    '/dsh-balance-bubble/widget.js',
    '/dsh-balance-bubble/balance.json',
    '/dsh-balance-bubble/model.json',
    '/dsh-balance-bubble/character.png',
    '/dsh-balance-bubble/reference.png',
    '/dsh-balance-bubble/sound/click.wav',
  ]) {
    assert.ok(routes.has(p), 'missing route ' + p)
  }
})

test('tapIndex 注入配置 + 人物立绘 + 挂件脚本，顺序正确且幂等', () => {
  const html = '<html><body><div id="root"></div></body></html>'
  const once = taps[0](html)
  assert.match(once, /__DSH_BALANCE_BUBBLE__/)
  assert.match(once, /\/dsh-balance-bubble\/widget\.js/)
  // 立绘以 data URI 内联，避免额外网络请求 / CSP 资源限制
  assert.match(once, /__DSH_BALANCE_BUBBLE_ART__="data:image\/png;base64,/)
  // 配置必须早于挂件脚本
  assert.ok(once.indexOf('__DSH_BALANCE_BUBBLE_ART__') < once.indexOf('/dsh-balance-bubble/widget.js'))
  assert.equal(taps[0](once), once)
})

test('widget.js 路由返回 JavaScript', () => {
  const res = fakeRes()
  routes.get('/dsh-balance-bubble/widget.js').handler(fakeReq('/dsh-balance-bubble/widget.js'), res)
  assert.equal(res.status, 200)
  assert.match(String(res.headers['Content-Type']), /javascript/)
  assert.ok(res.body.length > 5000)
})

test('character.png / sound 路由返回正确 MIME 与字节', () => {
  const pngRes = fakeRes()
  routes.get('/dsh-balance-bubble/character.png').handler(fakeReq('/dsh-balance-bubble/character.png'), pngRes)
  assert.equal(pngRes.status, 200)
  assert.match(String(pngRes.headers['Content-Type']), /image\/png/)

  const wavRes = fakeRes()
  routes.get('/dsh-balance-bubble/sound/click.wav').handler(fakeReq('/dsh-balance-bubble/sound/click.wav'), wavRes)
  assert.equal(wavRes.status, 200)
  assert.match(String(wavRes.headers['Content-Type']), /audio\/wav/)
})

test('缺凭据时 balance.json 返回可读错误而不是抛异常', async () => {
  const res = fakeRes()
  await routes.get('/dsh-balance-bubble/balance.json').handler(fakeReq('/dsh-balance-bubble/balance.json'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'NO_KEY')
  assert.match(body.error, /DEEPSEEK_API_KEY/)
  assert.ok(body.pricing, '缺少峰谷定价信息')
  assert.ok(body.pricing.mode === 'peak' || body.pricing.mode === 'offPeak')
  assert.equal(body.model, 'deepseek-flash')
  assert.equal(body.todayUsage, null)
})

test('session/event 记录真实请求模型', () => {
  const handler = events.get('session/event')[0]
  assert.ok(handler, 'session/event 未注册')
  handler({ id: 's1' }, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
  })
  handler({ id: 's1' }, { type: 'assistant/message', data: {} })
})

test('切换到 pro 后 balance.json 的模型与单价跟随（按当前真实峰谷取价）', async () => {
  const res = fakeRes()
  await routes.get('/dsh-balance-bubble/balance.json').handler(fakeReq('/dsh-balance-bubble/balance.json'), res)
  const body = JSON.parse(res.body)
  assert.equal(body.model, 'deepseek-v4-pro')
  const expected = priceAt('deepseek-v4-pro', Date.now()).unit
  assert.deepEqual(body.pricing.unit, expected)
  assert.equal(body.pricing.mode, isPeak(Date.now()) ? 'peak' : 'offPeak')
})

test('pricingSnapshot 的最小字段集满足前端渲染', () => {
  const snap = pricingSnapshot(Date.now(), { model: 'deepseek-v4-flash' })
  for (const key of ['mode', 'label', 'peak', 'unit', 'model', 'policy']) {
    assert.ok(key in snap, 'missing ' + key)
  }
  assert.ok(isFinite(snap.unit.input))
})

await runAll()
