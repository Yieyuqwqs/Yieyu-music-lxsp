/**
 * LXSP 引擎测试入口（零依赖）
 *
 * 跑法：node --import ./tests/lxsp/hook.mjs tests/lxsp/run.mjs
 */
const suites = []
let current = null

const t = {
  suite(name, fn) {
    suites.push({ name, fn })
  },
  eq(actual, expected, label) {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) throw new Error(`${label ?? ''}\n  期望: ${b}\n  实际: ${a}`)
  },
  ok(value, label) {
    if (!value) throw new Error(`断言失败: ${label ?? ''}`)
  },
  async rejects(fn, code, label) {
    try {
      await fn()
    } catch (error) {
      if (code && error?.code !== code) throw new Error(`${label}: 期望错误码 ${code}，实际 ${error?.code} (${error.message})`)
      return error
    }
    throw new Error(`${label}: 期望抛错，但没有`)
  },
  async throws(fn, label) {
    return t.rejects(fn, undefined, label)
  },
}

const files = ['./pure.test.mjs', './resolver.test.mjs', './wire.test.mjs', './engine.test.mjs', './profiles.test.mjs', './hedge.test.mjs', './perkey.test.mjs', './wasm.test.mjs', './wasm-real.test.mjs', './listen-together.test.mjs', './room-session.test.mjs', './track-map.test.mjs']
for (const file of files) {
  const mod = await import(file)
  mod.default(t)
}

let passed = 0
let failed = 0
const failures = []

for (const suite of suites) {
  current = suite.name
  try {
    await suite.fn()
    passed += 1
    console.log(`  ✓ ${suite.name}`)
  } catch (error) {
    failed += 1
    failures.push({ name: suite.name, error })
    console.log(`  ✗ ${suite.name}`)
    console.log(`      ${String(error.message).split('\n').join('\n      ')}`)
  }
}

console.log(`\n${failed === 0 ? '全绿' : '有失败'}：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）`)
if (failed) {
  for (const item of failures) {
    console.log(`\n--- ${item.name} ---\n${item.error.stack}`)
  }
  process.exit(1)
}
