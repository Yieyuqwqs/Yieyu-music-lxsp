const suites = []
let current = null
const t = {
  suite(name, fn) { suites.push({ name, fn }) },
  eq(actual, expected, label) {
    const a = JSON.stringify(actual); const b = JSON.stringify(expected)
    if (a !== b) throw new Error(`${label ?? ''}\n  期望: ${b}\n  实际: ${a}`)
  },
  ok(value, label) { if (!value) throw new Error(`断言失败: ${label ?? ''}`) },
  async rejects(fn, code, label) {
    try { await fn() } catch (error) {
      if (code && error?.code !== code) throw new Error(`${label}: 期望 ${code}，实际 ${error?.code} (${error.message})`)
      return error
    }
    throw new Error(`${label}: 期望抛错`)
  },
}
for (const file of ['./clock.test.mjs', './room.test.mjs', './local-server.test.mjs']) {
  const mod = await import(file)
  mod.default(t)
}
let passed = 0; const failed = []
for (const suite of suites) {
  current = suite.name
  try { await suite.fn(); passed += 1; console.log(`  ✓ ${suite.name}`) }
  catch (error) { failed.push({ name: suite.name, error }); console.log(`  ✗ ${suite.name}`); console.log('      ' + String(error.message).split('\n').join('\n      ')) }
}
console.log(`\n${failed.length ? '有失败' : '全绿'}：${passed} 通过 / ${failed.length} 失败（共 ${passed + failed.length}）`)
if (failed.length) { for (const f of failed) console.log(`\n--- ${f.name} ---\n${f.error.stack}`); process.exit(1) }
export default t
