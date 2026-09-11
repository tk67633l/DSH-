#!/usr/bin/env node
/**
 * 把本插件安装进 DSH 的 profile，等价于：
 *
 *   dsh plugin --profile web add link:<本仓库路径>
 *
 * 做三件事：
 *   1. 把包目录物化到 <profile>/node_modules/<包名>；
 *   2. 在 <profile>/package.json 的 dependencies 里登记包名；
 *   3. 把包名加进 dsh.profile.bundles（bundle 层栈），并保留一份 package.json 备份。
 *
 * 用法：
 *   node tools/install.mjs                      # 默认 web profile
 *   node tools/install.mjs --profile web
 *   node tools/install.mjs --link               # 改为写入 link: 依赖（本地开发）
 *
 * 说明：DSH 在启动时装载 bundle 层栈，安装后需要重启 DSH 才会生效。
 */
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..') // 仓库根目录（tools/ 的上一级）

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf('--' + name)
  return at !== -1 && args[at + 1] ? args[at + 1] : fallback
}
const PROFILE = flag('profile', 'web')
const USE_LINK = args.includes('--link')

const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
const profileDir = join(home, 'profiles', PROFILE)
const manifestPath = join(profileDir, 'package.json')

if (!existsSync(manifestPath)) {
  console.error('找不到 profile 清单：' + manifestPath)
  console.error('请确认 DSH 已初始化，或用 --profile 指定正确的 profile 名。')
  process.exit(2)
}

const srcPkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
if (!srcPkg.dsh?.bundle?.patch) {
  console.error('ABORT: 源包没有声明 dsh.bundle.patch，无法作为 DSH 插件安装。')
  process.exit(2)
}

const dest = join(profileDir, 'node_modules', srcPkg.name)

// 1. 物化包目录（跳过 .git / .github / node_modules）
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
cpSync(SRC, dest, {
  recursive: true,
  filter: (path) => !/[\\/](\.git|\.github|node_modules)([\\/]|$)/.test(path),
})
console.log('installed:', srcPkg.name, srcPkg.version, '->', dest)

// 2. 登记依赖 + 3. 加入 bundle 层栈
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const dependency = USE_LINK ? `link:${SRC}` : `^${srcPkg.version}`
manifest.dependencies = { ...(manifest.dependencies ?? {}), [srcPkg.name]: dependency }
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(srcPkg.name)) bundles.push(srcPkg.name)
manifest.dsh = {
  ...(manifest.dsh ?? {}),
  profile: { ...(manifest.dsh?.profile ?? {}), bundles },
}
const backup = `${manifestPath}.pre-${srcPkg.name}.bak`
if (!existsSync(backup)) copyFileSync(manifestPath, backup)
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('backup written:', backup)
console.log('bundles now:', JSON.stringify(bundles))

// 4. 校验：模块可解析 + 关键资源就位
const require = createRequire(manifestPath)
try {
  console.log('verify resolve:', require.resolve(srcPkg.name + '/package.json'))
} catch (error) {
  console.error('警告：无法从 profile 解析 ' + srcPkg.name + '（' + error.message + '）')
  process.exitCode = 1
}
for (const asset of srcPkg.files ?? ['lib', 'assets']) {
  if (asset === 'README.md' || asset === 'LICENSE') continue
  const present = existsSync(join(dest, asset))
  console.log(present ? 'asset OK   ' : 'asset MISS ', asset)
  if (!present) process.exitCode = 1
}

console.log('\n重启 DSH 后生效（bundle 层栈在启动时装载）。')
console.log(process.exitCode ? 'INSTALL_FAILED' : 'INSTALL_OK')
