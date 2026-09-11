/* ============================================================================
 * dsh-balance-bubble —— 页面挂件（浏览器端注入脚本）
 * ----------------------------------------------------------------------------
 * 交互（以 reference.png 为原型）：
 *   1. 页面右下角显示蓝色小鲸鱼角色，头顶一只白底深蓝描边的对话气泡；
 *   2. 点角色 → 气泡展开，请求 /balance.json，显示「DeepSeek 余额 / ¥金额 / 今日已用」；
 *   3. 再点气泡（余额区域）→ 切换为「当前模型 峰期/谷期」卡片，5 秒后自动收起；
 *   4. 每次点击播放上传的音频（/sound/click.wav，Web Audio 解码；失败时合成提示音）；
 *   5. 角色可拖动，位置记忆在 localStorage；Esc / 点击空白处收起。
 *
 * 配置由 host 注入：window.__DSH_BALANCE_BUBBLE__ = { base, version }
 * ========================================================================== */
;(function () {
  'use strict'

  if (window.__dshBalanceBubble) return
  window.__dshBalanceBubble = true

  var CFG = window.__DSH_BALANCE_BUBBLE__ || {}
  var BASE = String(CFG.base || '/dsh-balance-bubble').replace(/\/+$/, '')
  var VERSION = String(CFG.version || '0')
  var URL_SCRIPT = BASE + '/widget.js'
  var URL_DATA = BASE + '/balance.json'
  var URL_MODEL = BASE + '/model.json'
  var URL_SOUND = BASE + '/sound/click.wav'
  var URL_CHAR = BASE + '/character.png'
  var URL_REF = BASE + '/reference.png'
  // 立绘模式：
  //   'photo'  —— 人物立绘（透明背景 PNG，默认；host 以 data URI 注入）
  //   'vector' —— 内置矢量小鲸鱼（photo 加载失败时的兜底）
  //   'traced' —— 矢量角色 + 参考原型图作底纹
  var ART_MODE = String(CFG.art || localStorage.getItem('dsh-balance-bubble:art') || 'photo')
  if (ART_MODE !== 'vector' && ART_MODE !== 'traced') ART_MODE = 'photo'
  var STORE_KEY = 'dsh-balance-bubble:pos'
  var POS_KEY = 'dsh-balance-bubble:pos-v1'
  var PHASE_MS = 5000 // 「峰期/谷期」显示时长：5 秒
  var CLICK_SLOP = 6 // 拖动判定阈值（px）
  var DRAG_MS = 320

  // ---------------------------------------------------------------- utilities
  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function fmtMoney(value) {
    var n = Number(value)
    if (!isFinite(n)) return '--'
    var fixed = n.toFixed(2)
    var parts = fixed.split('.')
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return parts.join('.')
  }

  var CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€' }
  function symbolOf(currency) {
    return CURRENCY_SYMBOLS[String(currency || 'CNY').toUpperCase()] || String(currency || '') + ' '
  }

  function fmtDuration(minutes) {
    var m = Math.max(0, Math.round(Number(minutes) || 0))
    if (m < 60) return m + ' 分钟'
    var h = Math.floor(m / 60)
    var rest = m % 60
    return rest === 0 ? h + ' 小时' : h + ' 小时 ' + rest + ' 分'
  }

  function fmtClock(ms) {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: (CFG.timezone || 'Asia/Shanghai'),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms))
    } catch (err) {
      return new Date(ms).toTimeString().slice(0, 5)
    }
  }

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null')
    } catch (err) {
      return null
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (err) {
      /* 隐私模式或存储已满：忽略 */
    }
  }

  function fetchJSON(url, options) {
    var opt = options || {}
    var ctrl = null
    var timer = null
    try {
      ctrl = new AbortController()
      timer = setTimeout(function () {
        try {
          ctrl.abort()
        } catch (err) {}
      }, 20000)
    } catch (err) {}
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined, method: opt.method, headers: opt.headers, body: opt.body })
      .then(function (res) {
        return res.json()
      })
      .finally(function () {
        if (timer) clearTimeout(timer)
      })
  }

  // ------------------------------------------------------------------- audio
  // 上传音频（host 侧转码为 WAV）→ Web Audio 解码播放；失败时用振荡器合成提示音。
  var audio = {
    ctx: null,
    buffer: null,
    loading: null,
    failed: false,
    gain: 0.9,
  }

  function audioContext() {
    if (audio.ctx) return audio.ctx
    var Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return null
    try {
      audio.ctx = new Ctor()
    } catch (err) {
      audio.ctx = null
    }
    return audio.ctx
  }

  function loadSound(ctx) {
    if (audio.buffer || audio.failed) return Promise.resolve(audio.buffer)
    if (audio.loading) return audio.loading
    audio.loading = fetch(URL_SOUND + '?v=' + VERSION, { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.arrayBuffer()
      })
      .then(function (bytes) {
        return new Promise(function (resolve, reject) {
          var ret = ctx.decodeAudioData(bytes, resolve, reject)
          if (ret && typeof ret.then === 'function') ret.then(resolve, reject)
        })
      })
      .then(function (buffer) {
        audio.buffer = buffer
        return buffer
      })
      .catch(function () {
        audio.failed = true
        return null
      })
      .finally(function () {
        audio.loading = null
      })
    return audio.loading
  }

  function synthClick(ctx) {
    // 上传音频不可用时的兜底：两声短促的上行提示音。
    var now = ctx.currentTime
    var osc = ctx.createOscillator()
    var gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(660, now)
    osc.frequency.exponentialRampToValueAtTime(1180, now + 0.09)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.22 * audio.gain, now + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.2)
  }

  function playClick() {
    var ctx = audioContext()
    if (!ctx) return
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        ctx.resume()
      } catch (err) {}
    }
    loadSound(ctx).then(function (buffer) {
      if (!buffer) {
        synthClick(ctx)
        return
      }
      try {
        var src = ctx.createBufferSource()
        var gain = ctx.createGain()
        gain.gain.value = audio.gain
        src.buffer = buffer
        src.connect(gain).connect(ctx.destination)
        src.start(0)
      } catch (err) {
        synthClick(ctx)
      }
    })
  }

  // -------------------------------------------------------------------- style
  var CSS = [
    '.dshbb-root{position:fixed;right:10px;bottom:10px;--dshbb-size:clamp(126px,15vw,172px);--dshbb-navy:#16265c;--dshbb-navy-deep:#0f1c49;--dshbb-mid:#3d5da8;--dshbb-soft:#7d93c8;--dshbb-ink:#4a66ad;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;pointer-events:none;user-select:none;-webkit-user-select:none;touch-action:none}',

    '.dshbb-stage{position:relative;width:var(--dshbb-size);height:var(--dshbb-size);pointer-events:auto;cursor:grab;transition:transform .18s ease}',

    '.dshbb-stage.dshbb-dragging{cursor:grabbing;transition:none}',

    '.dshbb-char{position:absolute;inset:0;border-radius:24px;overflow:hidden;background:var(--dshbb-navy-deep);box-shadow:0 16px 38px rgba(9,16,42,.42),0 0 0 1px rgba(125,147,200,.22) inset}',

    '.dshbb-char svg{display:block;width:100%;height:100%}',

    '.dshbb-charimg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 42%;display:block;pointer-events:none;user-select:none;-webkit-user-drag:none;filter:drop-shadow(0 3px 7px rgba(9,16,42,.55)) drop-shadow(0 0 14px rgba(150,175,235,.4))}',
    // 人物立绘：不要方框与遮罩，让透明背景直接融进界面
    '.dshbb-char-photo{background:none;border-radius:0;overflow:visible;box-shadow:none}',
    // 底纹模式下让原型纹样在角色四周淡淡透出
    '.dshbb-char-traced .dshbb-ref-img{opacity:.34}',
    '.dshbb-char-traced .dshbb-art{opacity:.97}',

    '.dshbb-stage:hover .dshbb-char{box-shadow:0 18px 44px rgba(9,16,42,.5),0 0 0 1px rgba(140,166,226,.36) inset}',
    '.dshbb-stage:hover .dshbb-char-photo{box-shadow:none;filter:brightness(1.06)}',

    '.dshbb-stage.dshbb-open .dshbb-char{box-shadow:0 14px 34px rgba(9,16,42,.5),0 0 0 2px rgba(140,166,226,.4) inset}',
    '.dshbb-stage.dshbb-open .dshbb-char-photo{box-shadow:none}',
    '.dshbb-stage.dshbb-open .dshbb-charimg{filter:drop-shadow(0 4px 9px rgba(9,16,42,.6)) drop-shadow(0 0 20px rgba(160,185,240,.55))}',

    '.dshbb-hint{position:absolute;left:50%;bottom:2px;transform:translateX(-50%);font-size:11px;letter-spacing:.06em;color:#e6ecfd;opacity:.92;text-shadow:0 1px 4px rgba(0,0,0,.85),0 0 8px rgba(0,0,0,.6);pointer-events:none;white-space:nowrap}',

    /* ---------------- bubble ---------------- */
    '.dshbb-bubble{position:absolute;left:50%;bottom:calc(100% - 12px);width:clamp(206px,26vw,288px);transform:translate(-50%,10px) scale(.72);transform-origin:50% 100%;opacity:0;visibility:hidden;transition:opacity .2s ease,transform .26s cubic-bezier(.34,1.56,.64,1),visibility .26s;pointer-events:none}',
    '.dshbb-stage.dshbb-open .dshbb-bubble{opacity:1;visibility:visible;transform:translate(-50%,0) scale(1);pointer-events:auto}',

    '.dshbb-card{position:relative;background:#fdfdfe;border:5px solid var(--dshbb-navy);border-radius:46% / 48%;padding:16px 18px 18px;box-shadow:0 12px 28px rgba(10,18,46,.32);text-align:center;cursor:pointer;box-sizing:border-box}',

    '.dshbb-tail{position:absolute;left:50%;bottom:-14px;margin-left:-11px;width:0;height:0;border-left:12px solid transparent;border-right:12px solid transparent;border-top:15px solid var(--dshbb-navy);pointer-events:none}',
    '.dshbb-tail::after{content:"";position:absolute;left:-8px;top:-15px;width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:11px solid #fdfdfe}',

    '.dshbb-title{font-size:15px;font-weight:700;letter-spacing:.04em;color:var(--dshbb-ink);line-height:1.35}',
    '.dshbb-title small{display:block;font-size:10.5px;font-weight:600;letter-spacing:.14em;color:var(--dshbb-soft);margin-top:2px}',

    '.dshbb-amount{font-size:34px;font-weight:800;color:var(--dshbb-ink);line-height:1.16;margin-top:4px;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.dshbb-amount .dshbb-amount-num{display:inline-block}',
    '.dshbb-amount.dshbb-rolling .dshbb-amount-num{animation:dshbb-roll .5s ease both}',
    '@keyframes dshbb-roll{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}',

    '.dshbb-sub{font-size:13px;font-weight:600;color:var(--dshbb-soft);margin-top:6px;font-variant-numeric:tabular-nums}',
    '.dshbb-sub b{color:var(--dshbb-ink);font-weight:700}',

    '.dshbb-err{font-size:12.5px;color:#c0392b;margin-top:8px;line-height:1.4;word-break:break-word}',

    /* ---------------- phase card ---------------- */
    '.dshbb-phase{font-size:13px;font-weight:700;color:var(--dshbb-ink);letter-spacing:.03em}',
    '.dshbb-badge{display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:3px 12px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.06em;color:#fff}',
    '.dshbb-badge i{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85}',
    '.dshbb-peak{background:#d4443c}',
    '.dshbb-off{background:#2f9e5f}',
    '.dshbb-flat{background:var(--dshbb-mid)}',
    '.dshbb-model{font-size:11px;color:var(--dshbb-soft);margin-top:7px;font-weight:600;word-break:break-all}',
    '.dshbb-rate{font-size:11.5px;color:var(--dshbb-ink);margin-top:5px;font-variant-numeric:tabular-nums;line-height:1.45}',
    '.dshbb-timer{margin-top:8px;height:4px;border-radius:999px;background:#dfe5f4;overflow:hidden}',
    '.dshbb-timer span{display:block;height:100%;width:100%;background:var(--dshbb-mid);transform-origin:0 50%;animation:dshbb-shrink 5s linear both}',
    '@keyframes dshbb-shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}',
    '.dshbb-note{font-size:10.5px;color:var(--dshbb-soft);margin-top:6px}',
    '.dshbb-spin{width:22px;height:22px;margin:12px auto 8px;border-radius:50%;border:3px solid #dbe2f2;border-top-color:var(--dshbb-ink);animation:dshbb-spin .8s linear infinite}',
    '@keyframes dshbb-spin{to{transform:rotate(360deg)}}',

    '@media (prefers-reduced-motion: reduce){.dshbb-bubble,.dshbb-stage,.dshbb-char{transition:none}.dshbb-timer span{animation-duration:5s}}',
    '@media (max-width:560px){.dshbb-root{--dshbb-size:116px;right:6px;bottom:6px}.dshbb-bubble{width:198px}.dshbb-amount{font-size:29px}}',
  ].join('\n')

  function injectStyles() {
    if (document.getElementById('dshbb-style')) return
    var style = el('style')
    style.id = 'dshbb-style'
    style.textContent = CSS
    document.head.appendChild(style)
  }

  // 角色立绘：矢量图（缩放不糊）。host 同时把「参考原型图」作为极淡底纹叠在下面，
  // 保留用户提供的原始构图与配色。
  var FALLBACK_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 240" width="340" height="240">' +
    '<defs><linearGradient id="fbg" x1="0" y1="0" x2="0.6" y2="1">' +
    '<stop offset="0" stop-color="#1b2a5e"/><stop offset="1" stop-color="#0d1330"/></linearGradient>' +
    '<linearGradient id="fha" x1="0.1" y1="0" x2="0.9" y2="1">' +
    '<stop offset="0" stop-color="#6f8ac0"/><stop offset="1" stop-color="#1a2a5f"/></linearGradient></defs>' +
    '<rect width="340" height="240" fill="url(#fbg)"/>' +
    '<path d="M96 6 C58 20 26 62 18 112 C12 152 22 196 40 240 L108 240 C82 192 70 146 78 104 C86 66 104 28 132 10 Z" fill="url(#fha)"/>' +
    '<ellipse cx="152" cy="62" rx="50" ry="56" fill="#dfe5f4"/>' +
    '<ellipse cx="128" cy="66" rx="9" ry="11" fill="#12224e"/><ellipse cx="172" cy="66" rx="9" ry="11" fill="#12224e"/>' +
    '<path d="M228 240 C232 210 250 184 274 170 C292 160 312 156 330 156 C336 174 332 196 320 212 C304 230 274 240 244 240 Z" fill="#40639f"/>' +
    '<circle cx="200" cy="188" r="12" fill="#e8eefc"/><circle cx="220" cy="216" r="9" fill="#e8eefc"/>' +
    '</svg>'

  function loadTracedArt(stage) {
    var host = stage.querySelector('.dshbb-art')
    if (!host) return
    fetch(URL_CHAR + '?v=' + VERSION, { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.text()
      })
      .then(function (markup) {
        if (markup && markup.indexOf('<svg') !== -1) host.innerHTML = markup
      })
      .catch(function () {})
  }

  /** 立绘图片地址：优先 host 注入的 data URI，否则走资源路由。 */
  function characterSource() {
    var injected = window.__DSH_BALANCE_BUBBLE_ART__
    return typeof injected === 'string' && injected ? injected : URL_CHAR + '?v=' + VERSION
  }

  /** 参考原型图作 'traced' 模式的底纹（可选装饰，失败就只显示矢量立绘）。 */
  function loadRefBackdrop(svg, artHost, stage) {
    fetch(URL_REF + '?v=' + VERSION, { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.blob()
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob)
        var refImg = document.createElementNS('http://www.w3.org/2000/svg', 'image')
        refImg.setAttribute('class', 'dshbb-ref-img')
        refImg.setAttribute('x', '-46')
        refImg.setAttribute('y', '0')
        refImg.setAttribute('width', '432')
        refImg.setAttribute('height', '318')
        refImg.setAttribute('preserveAspectRatio', 'xMidYMid slice')
        refImg.setAttribute('href', url)
        refImg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url)
        svg.insertBefore(refImg, artHost)
      })
      .catch(function () {})
  }

  // -------------------------------------------------------------------- build
  function build() {
    var root = el('div', 'dshbb-root')
    var stage = el('div', 'dshbb-stage')
    stage.setAttribute('role', 'button')
    stage.setAttribute('tabindex', '0')
    stage.setAttribute('aria-label', 'DeepSeek 余额挂件：点击查看余额')
    stage.title = 'DeepSeek 余额'

    var char = el('div', 'dshbb-char')
    char.setAttribute('data-art', ART_MODE)
    var svgNS = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('viewBox', '0 0 340 240')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice')
    var artHost = document.createElementNS(svgNS, 'g')
    artHost.setAttribute('class', 'dshbb-art')
    svg.appendChild(artHost)
    char.appendChild(svg)
    stage.appendChild(char)

    // 矢量兜底先就位：photo 失败时直接可见，不会出现空白方块。
    artHost.innerHTML = FALLBACK_SVG

    if (ART_MODE === 'traced') {
      char.classList.add('dshbb-char-traced')
      loadRefBackdrop(svg, artHost, stage)
    } else if (ART_MODE === 'photo') {
      char.classList.add('dshbb-char-photo')
      var photo = el('img', 'dshbb-charimg')
      photo.alt = 'DeepSeek 余额助手'
      photo.draggable = false
      photo.src = characterSource()
      // 立绘加载失败 → 退回矢量小鲸鱼
      photo.addEventListener('error', function () {
        ART_MODE = 'vector'
        char.classList.remove('dshbb-char-photo')
        char.setAttribute('data-art', 'vector')
        if (photo.parentNode) photo.parentNode.removeChild(photo)
        if (!artHost.innerHTML) artHost.innerHTML = FALLBACK_SVG
      })
      char.insertBefore(photo, svg)
      // data URI 已内联时无需隐藏矢量兜底（photo 层会完全覆盖它）
      if (photo.src.indexOf('data:') === 0) artHost.innerHTML = ''
    }

    var hint = el('div', 'dshbb-hint', '余额 / 峰谷')
    stage.appendChild(hint)

    var bubble = el('div', 'dshbb-bubble')
    var card = el('div', 'dshbb-card')
    var tail = el('div', 'dshbb-tail')
    card.appendChild(tail)
    bubble.appendChild(card)
    stage.appendChild(bubble)

    root.appendChild(stage)
    document.body.appendChild(root)

    return { root: root, stage: stage, card: card, bubble: bubble, hint: hint }
  }

  // ------------------------------------------------------------------- state
  var ui = null
  var state = {
    open: false,
    panel: 'idle', // idle | loading | balance | phase | error
    data: null,
    phase: null,
    timer: null,
    raf: 0,
    drag: null,
    lastFetch: 0,
    modelHint: '',
  }

  function clearPhaseTimer() {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  function render() {
    if (!ui) return
    var card = ui.card
    var tail = card.querySelector('.dshbb-tail')
    while (card.firstChild) card.removeChild(card.firstChild)
    if (tail) card.appendChild(tail)

    if (state.panel === 'loading') {
      card.appendChild(el('div', 'dshbb-title', 'DeepSeek 余额'))
      card.appendChild(el('div', 'dshbb-spin'))
      card.appendChild(el('div', 'dshbb-sub', '正在查询余额…'))
      ui.stage.setAttribute('aria-label', '正在查询 DeepSeek 余额')
      return
    }

    if (state.panel === 'phase' && state.phase) {
      renderPhase(card, state.phase)
      return
    }

    if (state.panel === 'error') {
      card.appendChild(el('div', 'dshbb-title', 'DeepSeek 余额'))
      card.appendChild(el('div', 'dshbb-amount', '--'))
      card.appendChild(el('div', 'dshbb-err', (state.data && state.data.error) || '获取失败，点此重试'))
      ui.stage.setAttribute('aria-label', '余额获取失败，点击重试')
      return
    }

    renderBalance(card)
  }

  function renderBalance(card) {
    var d = state.data || {}
    card.appendChild(el('div', 'dshbb-title', 'DeepSeek 余额'))
    var amount = el('div', 'dshbb-amount' + (state.rolled ? ' dshbb-rolling' : ''))
    var sym = symbolOf(d.currency)
    var num = el('span', 'dshbb-amount-num', sym + ' ' + fmtMoney(d.totalBalance))
    amount.appendChild(num)
    card.appendChild(amount)
    state.rolled = false

    var used = d.todayUsage
    var sub = el('div', 'dshbb-sub')
    if (used === null || used === undefined || !isFinite(Number(used))) {
      sub.textContent = '今日已用 --'
    } else {
      var approx = d.todayUsageSource === 'estimate' ? '≈ ' : ''
      sub.innerHTML = ''
      sub.appendChild(document.createTextNode('今日已用 '))
      var b = el('b', null, approx + sym + ' ' + fmtMoney(used))
      sub.appendChild(b)
    }
    card.appendChild(sub)

    if (d.stale) card.appendChild(el('div', 'dshbb-note', '（离线缓存余额，稍后自动刷新）'))
    var tip = el('div', 'dshbb-note', '点击查看当前模型 峰期 / 谷期')
    card.appendChild(tip)
    ui.stage.setAttribute('aria-label', '当前余额 ' + sym + ' ' + fmtMoney(d.totalBalance) + '，点击查看峰谷')
  }

  function renderPhase(card, p) {
    var modeCls = p.peak ? 'dshbb-peak' : p.mode === 'flat' ? 'dshbb-flat' : 'dshbb-off'
    card.appendChild(el('div', 'dshbb-phase', p.peak ? '当前处于 峰期' : p.mode === 'flat' ? '当前 常规计价' : '当前处于 谷期'))
    var badge = el('div', 'dshbb-badge ' + modeCls)
    badge.appendChild(el('i'))
    badge.appendChild(document.createTextNode(p.label + (p.peak ? '（高峰时段）' : '（空闲时段）')))
    card.appendChild(badge)

    var model = p.model || '未知模型'
    card.appendChild(el('div', 'dshbb-model', '当前模型：' + model))

    var unit = p.unit || {}
    card.appendChild(
      el(
        'div',
        'dshbb-rate',
        '输入 ¥' + unit.input + ' · 命中 ¥' + unit.cacheRead + ' · 输出 ¥' + unit.output + ' /百万token'
      )
    )

    if (p.weekend && p.mode === 'offPeak') {
      card.appendChild(el('div', 'dshbb-note', '周末全天按空闲（谷期）计价'))
    } else if (p.nextSwitch) {
      card.appendChild(
        el('div', 'dshbb-note', '距下一次' + (p.nextSwitch.mode === 'peak' ? '高峰' : '空闲') + ' ' + fmtDuration(p.nextSwitch.inMinutes) + '（' + fmtClock(p.nextSwitch.at) + '）')
      )
    }

    var timer = el('div', 'dshbb-timer')
    timer.appendChild(el('span'))
    card.appendChild(timer)
    ui.stage.setAttribute('aria-label', '当前模型 ' + model + '：' + p.label + '时段')
  }

  // ------------------------------------------------------------------ network
  function loadBalance(force) {
    var now = Date.now()
    if (!force && state.data && now - state.lastFetch < 1000) return Promise.resolve(state.data)
    state.panel = 'loading'
    render()
    return fetchJSON(URL_DATA)
      .then(function (data) {
        state.data = data
        state.lastFetch = Date.now()
        if (data && data.ok) {
          state.panel = 'balance'
          state.rolled = true
        } else {
          state.panel = 'error'
        }
        render()
        return data
      })
      .catch(function (err) {
        state.data = { ok: false, error: '网络异常：' + String((err && err.message) || err) }
        state.panel = 'error'
        render()
        return state.data
      })
  }

  function loadPhase() {
    var url = URL_DATA + '?model=' + encodeURIComponent(state.modelHint || '')
    return fetchJSON(url)
      .then(function (data) {
        if (data && data.ok && data.pricing) {
          state.phase = data.pricing
          state.panel = 'phase'
        } else {
          state.panel = 'error'
          state.data = data
        }
        render()
        return data
      })
      .catch(function (err) {
        state.panel = 'error'
        state.data = { ok: false, error: '峰谷查询失败：' + String((err && err.message) || err) }
        render()
      })
  }

  function rememberModelHint() {
    // 会话模型 id 可能出现在 localStorage / sessionStorage（不同 DSH 版本字段不同）。
    // 尽力提取，host 侧会优先使用自己监听到的实时模型。
    if (state.modelHint) return
    var keys = ['dsh-model', 'dsh.session.model', 'dsh-session-model']
    for (var i = 0; i < keys.length; i++) {
      var raw = null
      try {
        raw = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i])
      } catch (err) {
        raw = null
      }
      if (raw && raw.length < 200) {
        state.modelHint = raw.replace(/^"|"$/g, '')
        break
      }
    }
  }

  function reportModelHint() {
    rememberModelHint()
    if (!state.modelHint) return
    try {
      fetchJSON(URL_MODEL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: state.modelHint }),
      }).catch(function () {})
    } catch (err) {}
  }

  // --------------------------------------------------------------- open/close
  function openBubble() {
    if (!ui) return
    state.open = true
    ui.stage.classList.add('dshbb-open')
    loadBalance(false)
  }

  function closeBubble() {
    if (!ui) return
    clearPhaseTimer()
    state.open = false
    state.panel = 'idle'
    state.phase = null
    ui.stage.classList.remove('dshbb-open')
  }

  function showPhase() {
    loadPhase().then(function () {
      clearPhaseTimer()
      state.timer = setTimeout(function () {
        state.timer = null
        closeBubble()
      }, PHASE_MS)
      // 5 秒进度由 CSS animation 呈现；重新挂载节点以重启动画。
      if (state.panel === 'phase') {
        var bar = ui.card.querySelector('.dshbb-timer span')
        if (bar) {
          bar.style.animation = 'none'
          void bar.offsetWidth
          bar.style.animation = ''
        }
      }
    })
  }

  // ------------------------------------------------------------------ pointer
  function pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return
    var rect = ui.stage.getBoundingClientRect()
    state.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
      at: Date.now(),
    }
    ui.stage.classList.add('dshbb-dragging')
    try {
      ui.stage.setPointerCapture(event.pointerId)
    } catch (err) {}
  }

  function pointerMove(event) {
    var drag = state.drag
    if (!drag || drag.id !== event.pointerId) return
    var dx = event.clientX - drag.x
    var dy = event.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) drag.moved = true
    if (!drag.moved) return
    event.preventDefault()
    var size = ui.stage.offsetWidth || 180
    var maxLeft = Math.max(0, window.innerWidth - size)
    var maxTop = Math.max(0, window.innerHeight - size)
    var left = Math.min(Math.max(0, drag.left + dx), maxLeft)
    var top = Math.min(Math.max(0, drag.top + dy), maxTop)
    ui.root.style.left = left + 'px'
    ui.root.style.top = top + 'px'
    ui.root.style.right = 'auto'
    ui.root.style.bottom = 'auto'
  }

  function pointerUp(event) {
    var drag = state.drag
    if (!drag || drag.id !== event.pointerId) return
    state.drag = null
    ui.stage.classList.remove('dshbb-dragging')
    try {
      ui.stage.releasePointerCapture(event.pointerId)
    } catch (err) {}
    if (drag.moved) {
      var rect = ui.stage.getBoundingClientRect()
      writeJSON(POS_KEY, { v: 1, left: Math.round(rect.left), top: Math.round(rect.top) })
      return
    }
    if (Date.now() - drag.at > DRAG_MS * 4) return
    onClick()
  }

  var clickGuard = 0
  function onClick() {
    // 文本选择/双击产生的重复事件用最短间隔过滤。
    var now = Date.now()
    if (now - clickGuard < 180) return
    clickGuard = now

    playClick()
    reportModelHint()

    if (!state.open) {
      openBubble()
      return
    }
    if (state.panel === 'phase') {
      // 已在峰谷卡片：重新计时。
      showPhase()
      return
    }
    if (state.panel === 'loading') return
    if (state.panel === 'error') {
      loadBalance(true)
      return
    }
    // 余额卡片 → 峰期/谷期卡片（5 秒后自动收起）
    showPhase()
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && state.open) closeBubble()
    if ((event.key === 'Enter' || event.key === ' ') && document.activeElement === ui.stage) {
      event.preventDefault()
      onClick()
    }
  }

  function onDocumentDown(event) {
    if (!state.open) return
    if (ui.root.contains(event.target)) return
    closeBubble()
  }

  function restorePosition() {
    var saved = readJSON(POS_KEY) || readJSON(STORE_KEY)
    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return
    var size = ui.stage.offsetWidth || 180
    var left = Math.min(Math.max(0, saved.left), Math.max(0, window.innerWidth - size))
    var top = Math.min(Math.max(0, saved.top), Math.max(0, window.innerHeight - size))
    ui.root.style.left = left + 'px'
    ui.root.style.top = top + 'px'
    ui.root.style.right = 'auto'
    ui.root.style.bottom = 'auto'
  }

  function keepInView() {
    var style = ui.root.style
    if (!style.left) return
    var size = ui.stage.offsetWidth || 180
    var left = Math.min(Math.max(0, parseFloat(style.left) || 0), Math.max(0, window.innerWidth - size))
    var top = Math.min(Math.max(0, parseFloat(style.top) || 0), Math.max(0, window.innerHeight - size))
    style.left = left + 'px'
    style.top = top + 'px'
  }

  function start() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', start, { once: true })
      return
    }
    if (document.querySelector('.dshbb-root')) return
    injectStyles()
    ui = build()
    restorePosition()

    ui.stage.addEventListener('pointerdown', pointerDown)
    ui.stage.addEventListener('pointermove', pointerMove)
    ui.stage.addEventListener('pointerup', pointerUp)
    ui.stage.addEventListener('pointercancel', pointerUp)
    ui.stage.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onDocumentDown, true)
    window.addEventListener('resize', keepInView)
    window.addEventListener('keydown', onKeyDown)

    // 模型切换后重新获取一次（不展开气泡）。
    window.addEventListener('dshbb:model-changed', function () {
      state.lastFetch = 0
      if (state.open) loadBalance(true)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
