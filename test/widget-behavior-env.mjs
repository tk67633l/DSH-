/** 最小 DOM 环境（供 widget 行为测试与调试脚本复用）。 */
export class ClassList {
  constructor(node) {
    this.node = node
    this.set = new Set()
  }
  add(...names) {
    for (const n of names) this.set.add(n)
  }
  remove(...names) {
    for (const n of names) this.set.delete(n)
  }
  contains(name) {
    return this.set.has(name)
  }
  toString() {
    return [...this.set].join(' ')
  }
}

export class Node {
  constructor(tag, ns) {
    this.tagName = String(tag).toUpperCase()
    this.localName = String(tag)
    this.namespaceURI = ns || null
    this.childNodes = []
    this.parentNode = null
    this.attributes = new Map()
    this.style = { setProperty() {} }
    this.dataset = {}
    this._text = ''
    this.listeners = new Map()
    this.classList = new ClassList(this)
    this.offsetWidth = 160
    this.offsetHeight = 160
    this.firstChild = null
  }
  get className() {
    return this.classList.toString()
  }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean))
  }
  // 子树文本（真实 DOM 的 textContent 语义：拼接所有后代文本）
  get textContent() {
    if (this.childNodes.length === 0) return this._text
    return this.childNodes.map((child) => child.textContent).join('')
  }
  set textContent(value) {
    this.childNodes = []
    this.firstChild = null
    this._text = value === undefined || value === null ? '' : String(value)
  }
  get innerHTML() {
    return this._html || ''
  }
  set innerHTML(value) {
    this._html = String(value)
    this.childNodes = []
  }
  appendChild(node) {
    node.parentNode = this
    this.childNodes.push(node)
    this.firstChild = this.childNodes[0]
    return node
  }
  insertBefore(node, ref) {
    node.parentNode = this
    const at = ref ? this.childNodes.indexOf(ref) : -1
    if (at === -1) this.childNodes.push(node)
    else this.childNodes.splice(at, 0, node)
    this.firstChild = this.childNodes[0]
    return node
  }
  removeChild(node) {
    const at = this.childNodes.indexOf(node)
    if (at !== -1) this.childNodes.splice(at, 1)
    node.parentNode = null
    this.firstChild = this.childNodes[0] || null
    return node
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  setAttributeNS(_ns, name, value) {
    this.attributes.set(name, String(value))
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener() {}
  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event)
  }
  getBoundingClientRect() {
    return { left: 800, top: 500, width: 160, height: 160, right: 960, bottom: 660 }
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
  querySelectorAll(selector) {
    const wanted = selector.trim()
    const out = []
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (!child.classList) continue // 文本节点没有 classList
        const match = wanted.startsWith('.')
          ? child.classList.contains(wanted.slice(1)) || String(child.getAttribute('class') || '').split(/\s+/).includes(wanted.slice(1))
          : child.localName === wanted.toLowerCase()
        if (match) out.push(child)
        visit(child)
      }
    }
    visit(this)
    return out
  }
  get outerHTML() {
    return '<' + this.localName + (this.className ? ' class="' + this.className + '"' : '') + '>'
  }
}

class TextNode {
  constructor(text) {
    this.nodeType = 3
    this.textContent = String(text)
    this.parentNode = null
    this.childNodes = []
  }
}

/** 建一个挂件能跑起来的沙箱（document/window/fetch/localStorage/timer 全部可控）。 */
export function makeEnv() {
  const document = new Node('#document')
  const head = new Node('head')
  const body = new Node('body')
  document.appendChild(head)
  document.appendChild(body)
  document.head = head
  document.body = body
  document.documentElement = document
  document.readyState = 'complete'
  document.createElement = (tag) => new Node(tag)
  document.createElementNS = (ns, tag) => new Node(tag, ns)
  document.createTextNode = (text) => new TextNode(text)
  document.getElementById = () => null
  document.addEventListener = () => {}
  document.activeElement = null

  const store = new Map()
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }

  const calls = { fetch: [], timers: [] }
  const pending = []
  const fetch = (url) => {
    calls.fetch.push(String(url))
    let payload = { ok: false, code: 'NO_KEY', error: 'stub' }
    if (String(url).indexOf('/balance.json') !== -1) {
      payload = {
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
          nextSwitch: { at: Date.now() + 30 * 60000, mode: 'offPeak', inMinutes: 30 },
        },
      }
    } else if (String(url).indexOf('/reference.png') !== -1) {
      return Promise.resolve({ ok: false, status: 404, blob: async () => new Blob() })
    } else if (String(url).indexOf('/art.svg') !== -1) {
      return Promise.resolve({ ok: true, status: 200, text: async () => '<svg><g/></svg>' })
    } else if (String(url).indexOf('/sound/') !== -1) {
      return Promise.resolve({ ok: false, status: 404 })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })
  }

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    document,
    localStorage,
    fetch,
    setTimeout: (fn, ms) => {
      const id = pending.length + 1
      pending.push({ fn, ms, id })
      calls.timers.push(ms)
      return id
    },
    clearTimeout: (id) => {
      const at = pending.findIndex((t) => t && t.id === id)
      if (at !== -1) pending[at] = null
    },
    addEventListener: () => {},
    __DSH_BALANCE_BUBBLE__: { base: '/dsh-balance-bubble', version: 'test' },
  }
  window.window = window
  window.self = window
  window.globalThis = window
  window.AudioContext = undefined
  window.webkitAudioContext = undefined

  const sandbox = {
    window,
    document,
    localStorage,
    fetch,
    Blob: class Blob {},
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    AbortController,
    Intl,
    Date,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Error,
    Promise,
    Set,
    Map,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  }
  sandbox.globalThis = sandbox
  return { sandbox, window, document, calls, pending: () => pending.filter(Boolean) }
}
