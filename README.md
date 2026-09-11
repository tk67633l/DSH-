# dsh-balance-bubble

DSH Web 界面上的 **DeepSeek 余额气泡挂件**（以参考图一为原型）。

```
        ╭──────────────────────────╮
        │      DeepSeek 余额        │
        │        ¥ 3.94            │   ← 点击人物出现
        │   今日已用 ¥ 0.00         │
        ╰───────────╮──────────────╯
                    ▼
              ✿ 人物立绘 ✿               ← 点这里：查余额
               余额 / 峰谷
```

## 交互

| 操作 | 效果 |
| --- | --- |
| 点右下角的人物立绘 | 气泡展开，查询并显示「DeepSeek 余额 / ¥ 金额 / 今日已用」 |
| 再点气泡（余额区域） | 切换为「当前模型处于 **峰期** 还是 **谷期**」卡片，**5 秒后自动收起** |
| 每次点击 | 播放音频（默认是上传音频转码后的 `assets/click.wav`） |
| 拖动立绘 | 移动挂件位置，位置记忆在浏览器 `localStorage` |
| `Esc` / 点击页面空白 | 收起气泡 |

峰谷卡片还会一起显示：当前模型名、该模型的实时单价（输入 / 缓存命中 / 输出，元每百万 token）、
以及距下一次峰谷切换还有多久。

## 峰谷规则（与 DeepSeek 官方一致）

- 时区：北京时间（Asia/Shanghai）
- **高峰**：周一至周五 `09:00–12:00`、`14:00–18:00`
- **空闲（谷期）**：其余时间，含**周六、周日全天**
- 高峰价为空闲价的 2 倍

价格表按 M×N 升级维护：`lib/pricing.js` 的 `POLICIES` 按生效时间排列，新政策**追加**即可，
历史账单仍按当时政策计算。当前已内置：

| 生效时间 | 政策 |
| --- | --- |
| 2025-02-09 | `deepseek-chat` / `deepseek-reasoner` 标准价 |
| 2026-05-22 | V4 系列 75% 降价转永久 |
| 2026-08-17 | V4 系列启用峰谷定价 |
| 2026-09-10 12:00 | flash 系列二次降价（缓存命中直降 60%）：空闲 `1 / 0.02 / 4`，高峰 `2 / 0.04 / 8` |

未被最新政策点名的模型（如 `deepseek-v4-pro`）自动沿用最近一次点名它的政策价，
因此峰谷成对出现的历史价永远对得上平台账单。

## 当前模型是怎么确定的

峰谷状态对所有模型一致，但**单价**取决于模型，所以插件按以下顺序解析当前模型：

1. **实时会话事件**：监听 `session/event` 的 `request/header`，拿到真正发给 provider 的
   `provider / model`（模型一切换就立刻生效）；
2. **会话投影 `modelSelection`**：读取已挂载会话的 `pending / lastUsed`；
3. **`agentDefaultModel`**：本机默认模型设置；
4. **前端上报**：`POST /model.json` 的提示值。

## 数据来源与凭据

| 数据 | 接口 | 凭据 |
| --- | --- | --- |
| 余额 | `api.deepseek.com/user/balance`（官方公开） | `DEEPSEEK_API_KEY`（与调用模型共用，只读） |
| 今日已用 | `platform.deepseek.com/api/v0/usage/cost`（网页接口，可选） | `DEEPSEEK_PLATFORM_TOKEN` |
| 今日已用（兜底） | 本地记录当日开盘余额做差分估算 | 无 |

- 平台 token 未配置时，「今日已用」是**估算值**，界面会加 `≈` 前缀；
- 估算状态写在 `$DSH_HOME/storages/balance-bubble-day.json`；删除该文件可重置当日基准
  （重置后当天的第一次查询只能记下开盘余额，需下次查询才有读数）；
- 凭据只在 DSH 宿主进程内存中使用，**API Key 永远不会下发到浏览器**，浏览器只与本机路由通信。

## 安装

```bash
# 正式安装
dsh plugin --profile web add dsh-balance-bubble

# 直接从 GitHub 安装（仓库根目录即插件本体）
dsh plugin --profile web add github:tk67633l/DSH-

# 本地开发（link 安装）
dsh plugin --profile web add link:<本仓库绝对路径>
```

安装后**重启 DSH**（bundle 层栈在启动时装载）；刷新页面即可看到挂件。

不想用 `dsh plugin` CLI 时，仓库自带等价脚本（物化到 profile 的 `node_modules`、
登记 `dependencies`、把包名加进 `dsh.profile.bundles`，并备份原 `package.json`）：

```bash
node tools/install.mjs                # 默认 web profile
node tools/install.mjs --link         # 以 link: 方式登记（本地开发）
node tools/install.mjs --profile web  # 指定 profile
```

## 自检

```bash
npm test          # 等价于 node test/run-tests.mjs
```

两个套件，都不访问网络：

- `test/selftest.mjs` —— 定价引擎（峰谷边界、周末、政策切换、历史一致性）、host 路由注册与
  JSON 结构、资源 MIME 与格式、注入顺序与幂等；
- `test/widget-behavior.mjs` —— 在一个最小 DOM 环境里**真正执行** `lib/widget.js`，驱动点击流：
  挂载 → loading → 余额 → 峰谷 → 5 秒自动收起 → 拖动不误触 → 键盘可达 → 音频解码/播放
  （配套的假 DOM 在 `test/widget-behavior-env.mjs`）。

另有一个会**真实联网**的端到端校验（起真 HTTP 服务、调真实余额接口，凭据只在本进程内存使用）：

```bash
node test/verify-live.mjs             # 用已安装副本 + 真实余额接口
node test/verify-live.mjs --local     # 用本仓库代码
node test/verify-live.mjs --offline   # 不联网，只校验路由与资源
```

## 预览

![挂件预览](docs/preview-widget.png)

音效波形与频谱（取自视频音轨，已剪掉开头静音）：

![音效波形](docs/preview-audio-waveform.png)

![音效频谱](docs/preview-audio-spectrum.png)

## 立绘

默认使用 `assets/character.png`：用户提供的人物插画，**已抠掉白色背景**（透明 PNG，512×469，
调色板编码约 100KB），由 host 以 data URI 内联注入，不产生额外请求。
样式上用 `drop-shadow` 给人物描了一圈柔和光晕，保证浅发色在深色界面上也能看清轮廓。

抠图脚本在 `E:\deepseekdm\work\cutout.py`（从画面边界洪水填充 + 腐蚀羽化；
人物内部的白色高光与浅色刘海不会被误删）。

可在浏览器控制台切换风格后刷新：

```js
localStorage.setItem('dsh-balance-bubble:art', 'vector') // 改用内置矢量小鲸鱼
localStorage.setItem('dsh-balance-bubble:art', 'traced') // 矢量小鲸鱼 + 参考原型图底纹
localStorage.removeItem('dsh-balance-bubble:art')        // 回到默认人物立绘
```

`assets/reference.png` 是用户提供的参考原型图（图一），仅在 `traced` 风格里作为底纹出现。
若立绘缺失或解码失败，挂件自动退回内置矢量小鲸鱼，不会出现空白方块。

## 音频

`assets/click.wav` 由上传的视频 `video_20260912_010431.mp4` 的音轨转码而来
（原视频 1.87 秒；已剪掉开头 0.29 秒静音，成品 **1.58 秒**，44.1kHz 单声道，
响度 −18.5 LUFS、峰值 −5.5 dBFS）：

```bash
ffmpeg -i click.mp4 -vn \
  -af "silenceremove=start_periods=1:start_silence=0.02:start_threshold=-45dB:detection=peak,\
areverse,silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB:detection=peak,areverse,\
volume=4.5dB" \
  -c:a pcm_s16le -ar 44100 -ac 1 click.wav
```

原始音轨（1.87 秒，与视频一致）也留在 `assets/click.mp4` 便于对比或重新剪辑。

浏览器端用 Web Audio 解码后播放（不循环）；若资源或解码失败，会退回合成的短提示音，
因此点击**始终有反馈**。要换音效，直接替换 `assets/click.wav` 即可。

## 路由

| 路由 | 说明 |
| --- | --- |
| `GET /dsh-balance-bubble/widget.js` | 挂件脚本 |
| `GET /dsh-balance-bubble/balance.json` | 余额 + 今日已用 + 当前模型 + 峰谷定价 |
| `POST /dsh-balance-bubble/model.json` | 前端上报当前模型（可选提示） |
| `GET /dsh-balance-bubble/character.png` | 人物立绘（透明背景，host 同时以 data URI 内联） |
| `GET /dsh-balance-bubble/reference.png` | 参考原型图（仅 traced 底纹用） |
| `GET /dsh-balance-bubble/sound/click.wav` | 点击音效 |

## 卸载

```bash
dsh plugin --profile web remove dsh-balance-bubble
```

或恢复备份：`$DSH_HOME/profiles/web/package.json.pre-balance-bubble.bak`。

## 许可证

MIT
