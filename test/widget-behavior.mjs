/**
 * widget.js 行为测试：在最小 DOM 环境里真正执行挂件脚本，模拟点击流。
 *
 *   node test/widget-behavior.mjs
 *
 * 覆盖：脚本加载 → 建 UI → 点角色（拉余额）→ 再点（峰谷 + 5 秒计时）→ 5 秒后收起
 *      → 音频要素（Web Audio 解码上传音频）→ 拖动不误触。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { makeEnv } from './widget-behavior-env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'widget.js'), 'utf8')

const env = makeEnv()

// 让「点击播放上传音频」这条链路可观察：桩 AudioContext 记录解码与播放。
const audioLog = { contexts: 0, decoded: 0, started: 0, resumed: 0, buffers: [] }
class FakeAudioContext {
  constructor() {
    audioLog.contexts++
    this.state = 'running'
    this.currentTime = 0
    this.destination = { name: 'destination' }
  }
  resume() {
    audioLog.resumed++
    return Promise.resolve()
  }
  decodeAudioData(bytes, ok) {
    audioLog.decoded++
    audioLog.buffers.push(bytes && bytes.byteLength)
    const buffer = { duration: 1.17, sampleRate: 44100, numberOfChannels: 1 }
    if (typeof ok === 'function') ok(buffer)
    return Promise.resolve(buffer)
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {
        return { connect() {} }
      },
      start() {
        audioLog.started++
      },
    }
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => ({ connect() {} }) }
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: () => ({ connect() {} }),
      start() {},
      stop() {},
    }
  }
}
env.window.AudioContext = FakeAudioContext
env.sandbox.AudioContext = FakeAudioContext

// 可控时钟：Date.now 走假时间，方便跨过挂件的 180ms 防连点窗口
const clock = { t: 1_700_000_000_000 }
const RealDate = Date
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock.t)
    else super(...args)
  }
  static now() {
    return clock.t
  }
}
env.sandbox.Date = FakeDate
env.window.Date = FakeDate

// 音效资源返回真实字节，便于断言解码链路。
// 注意：sandbox.fetch 是挂件直接调用的全局 fetch；window.fetch 只是被挂件保存的引用。
const baseFetch = env.sandbox.fetch
let holdBalance = null // 让 balance.json 悬停，便于断言 loading 态
const testFetch = (url) => {
  const target = String(url)
  env.calls.fetch.push(target) // 统一记录（含音效等资源请求）
  if (target.indexOf('/sound/click.wav') !== -1) {
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer,
    })
  }
  if (target.indexOf('/balance.json') !== -1 && holdBalance) {
    return holdBalance.promise
  }
  return baseFetch(target)
}
env.sandbox.fetch = testFetch
env.window.fetch = testFetch
// 模拟 host 注入的人物立绘 data URI（真实运行时是 ~130KB 的 base64 PNG）
env.window.__DSH_BALANCE_BUBBLE_ART__ = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

vm.createContext(env.sandbox)
vm.runInContext(SOURCE, env.sandbox, { filename: 'widget.js' })

let failures = 0
const ok = (label, cond, detail) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '  → ' + detail))
  if (!cond) failures++
}

const stage = env.document.body.querySelector('.dshbb-stage')
const card = () => stage.querySelector('.dshbb-card')
const pointer = (type, x, y) => stage.dispatch(type, { button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} })
const clickAt = async (x = 800, y = 500) => {
  pointer('pointerdown', x, y)
  pointer('pointerup', x, y)
  await flush()
  clock.t += 300 // 跨过 180ms 防连点窗口
}

console.log('\n[挂载]')
ok('脚本执行后根节点挂到 body', !!env.document.body.querySelector('.dshbb-root'))
ok('stage 具备 role=button', stage && stage.getAttribute('role') === 'button')
ok('人物立绘容器与气泡卡片存在', !!(stage.querySelector('.dshbb-char') && stage.querySelector('.dshbb-card')))
ok('默认为人物立绘模式（photo）', stage.querySelector('.dshbb-char').getAttribute('data-art') === 'photo')
ok('立绘使用 host 注入的 data URI', stage.querySelector('.dshbb-charimg') !== null)
const charImg = stage.querySelector('.dshbb-charimg')
ok('立绘 src 为注入的 data URI', !!charImg && charImg.src.indexOf('data:image/png;base64,') === 0)
ok('立绘已隐藏矢量兜底（避免叠影）', stage.querySelector('.dshbb-art').innerHTML === '')
ok('初始状态气泡收起', !stage.classList.contains('dshbb-open'))

console.log('\n[第一次点击 → loading → 余额]')
let releaseBalance = null
holdBalance = { promise: new Promise((resolve) => { releaseBalance = resolve }) }
await clickAt()
ok('气泡展开', stage.classList.contains('dshbb-open'))
ok('请求 balance.json', env.calls.fetch.some((u) => u.indexOf('/balance.json') !== -1))
ok('余额未返回时显示 loading', !!card().querySelector('.dshbb-spin'))
ok('播放上传音频：创建了 AudioContext', audioLog.contexts === 1, 'contexts=' + audioLog.contexts)
ok('播放上传音频：拉取了 /sound/click.wav', env.calls.fetch.some((u) => u.indexOf('/sound/click.wav') !== -1))
ok('播放上传音频：完成解码', audioLog.decoded === 1, 'decoded=' + audioLog.decoded)
ok('播放上传音频：已开始播放', audioLog.started === 1, 'started=' + audioLog.started)

// 释放余额响应
const balancePayload = {
  ok: true,
  totalBalance: 3.94,
  currency: 'CNY',
  todayUsage: 0,
  todayUsageSource: 'official',
  model: 'deepseek-v4-flash',
  pricing: {
    mode: 'peak',
    label: '高峰',
    peak: true,
    weekend: false,
    model: 'deepseek-v4-flash',
    unit: { input: 2, cacheRead: 0.04, output: 8 },
    nextSwitch: { at: clock.t + 30 * 60000, mode: 'offPeak', inMinutes: 30 },
  },
}
holdBalance = null
releaseBalance({ ok: true, status: 200, json: async () => balancePayload, text: async () => JSON.stringify(balancePayload) })
await flush()

const amount = card().querySelector('.dshbb-amount-num')
ok('渲染金额 ¥ 3.94', !!amount && amount.textContent === '¥ 3.94', amount && amount.textContent)
ok('显示今日已用', card().querySelector('.dshbb-sub').textContent.indexOf('今日已用') !== -1)
ok('余额卡片提示可看峰谷', card().querySelectorAll('.dshbb-note').some((n) => n.textContent.indexOf('峰期') !== -1))
ok('未出现错误文案', !card().querySelector('.dshbb-err'))

console.log('\n[第二次点击 → 峰期/谷期]')
await clickAt()
ok('切换为峰谷卡片', !!card().querySelector('.dshbb-badge'))
ok('徽标显示高峰', card().querySelector('.dshbb-badge').textContent.indexOf('高峰') !== -1)
ok('显示当前模型', card().querySelector('.dshbb-model').textContent.indexOf('deepseek-v4-flash') !== -1)
ok('显示当前单价', card().querySelector('.dshbb-rate').textContent.indexOf('0.04') !== -1)
ok('显示距下次切换', card().querySelectorAll('.dshbb-note').some((n) => n.textContent.indexOf('距下一次') !== -1))
ok('带 5 秒进度条', !!card().querySelector('.dshbb-timer'))
ok('注册 5000ms 自动收起计时器', env.calls.timers.includes(5000))
ok('第二次点击也播放了音频', audioLog.started === 2, 'started=' + audioLog.started)

const phaseTimer = env.pending().find((t) => t.ms === 5000)
ok('取到 5 秒计时回调', !!phaseTimer)
if (phaseTimer) phaseTimer.fn()
ok('5 秒后气泡自动收起', !stage.classList.contains('dshbb-open'))

console.log('\n[拖动]')
const callsBefore = env.calls.fetch.length
pointer('pointerdown', 800, 500)
pointer('pointermove', 760, 470)
pointer('pointermove', 700, 420)
pointer('pointerup', 700, 420)
await flush()
ok('拖动后不展开气泡', !stage.classList.contains('dshbb-open'))
ok('拖动未产生数据请求', env.calls.fetch.length === callsBefore, env.calls.fetch.slice(callsBefore).join(','))
const pos = env.window.localStorage.getItem('dsh-balance-bubble:pos-v1')
ok('拖动位置写入 localStorage', !!pos && pos.indexOf('left') !== -1, pos)

console.log('\n[键盘]')
env.document.activeElement = stage // 模拟键盘焦点落在挂件上
stage.dispatch('keydown', { key: 'Enter', preventDefault() {} })
await flush()
ok('Enter 可打开气泡（键盘可达）', stage.classList.contains('dshbb-open'))

assert.ok(true) // 让 assert 导入不显得多余
console.log('\n' + (failures ? 'WIDGET BEHAVIOR FAILED (' + failures + ')' : 'WIDGET BEHAVIOR OK'))
process.exitCode = failures ? 1 : 0
