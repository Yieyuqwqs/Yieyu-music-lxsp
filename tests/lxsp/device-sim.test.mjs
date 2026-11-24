/**
 * 真机模拟闭环（宪法第十一条）：直接跑 tools/device-sim.mjs，任何一项 FAIL 即判红。
 * 它覆盖：真实端点 → 真实直链 → 播放前校验 → 故障注入回退，全程不用 mock。
 */
import { execFileSync } from 'node:child_process'

export default (t) => {
  t.suite('真机模拟闭环：真实链路 5 项断言必须全 PASS', () => {
    let output = ''
    let failed = false
    let envMissing = false
    try {
      output = execFileSync(process.execPath, ['tools/device-sim.mjs'], { encoding: 'utf8' })
    } catch (error) {
      output = String(error.stdout || error.message)
      envMissing = error.status === 2
      failed = !envMissing
    }
    if (envMissing) {
      console.log('    SKIP：本地 LXSP 网关未启动（退出码 2）——这条不算通过，需要先把网关跑起来才能验')
      t.ok(true, '明确未测（附原因）')
      return
    }
    const passed = (output.match(/PASS/g) || []).length
    const failedLines = output.split('\n').filter((line) => line.startsWith('FAIL')).length
    console.log('    ' + output.split('\n').filter((line) => /PASS|FAIL|合计/.test(line)).join('\n    '))
    t.ok(!failed, 'device-sim 必须退出码 0')
    t.ok(failedLines === 0, '不允许任何 FAIL 行')
    t.ok(passed >= 5, `至少 5 项 PASS，实际 ${passed}`)
  })
}
