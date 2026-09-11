/**
 * 插件自检入口：定价/路由静态检查 + 挂件行为测试。
 *
 *   node test/run-tests.mjs      （等价于 npm test）
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUITES = [
  ['定价引擎 · host 路由 · 资源', 'selftest.mjs'],
  ['挂件行为（最小 DOM 实跑）', 'widget-behavior.mjs'],
]

let failed = 0
for (const [label, file] of SUITES) {
  console.log('\n════ ' + label + ' ════')
  const result = spawnSync(process.execPath, [path.join(HERE, file)], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) failed++
}

console.log('\n════════════════════════════════')
console.log(failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILED')
process.exitCode = failed === 0 ? 0 : 1
