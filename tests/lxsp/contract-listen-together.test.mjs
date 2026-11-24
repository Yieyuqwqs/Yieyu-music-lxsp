/**
 * 契约测试：界面上调用的每个 service 方法、每个 status 字段都必须真实存在。
 *
 * 存在的理由很直白——上一轮我改了 service 和 UI 但漏写 playheadMs()，
 * 纯逻辑测试全绿，真机却白屏。这类“跨层契约”必须由测试卡住，而不是靠我记性。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repo = new URL('../../', import.meta.url)
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, repo)), 'utf8')

const SERVICE = 'src/core/listen-together/service.ts'
const UI = 'src/screens/Home/Views/Setting/settings/Other/ListenTogether.tsx'

const methodNames = (source) => {
  const names = new Set()
  const re = /^ {2}(?:private |public |protected )?(?:async )?([a-zA-Z_$][\w$]*)\s*\(/gm
  let match
  while ((match = re.exec(source)) !== null) names.add(match[1])
  return names
}

const statusFields = (source) => {
  const start = source.indexOf('export interface RoomStatus')
  if (start < 0) return new Set()
  // 接口里有内联对象类型，必须花括号配对，不能找第一个 }
  let depth = 0
  let end = start
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  const body = source.slice(start, end)
  const fields = new Set()
  const re = /^\s{2}([a-zA-Z_$][\w$]*)\s*[?:]/gm
  let match
  while ((match = re.exec(body)) !== null) fields.add(match[1])
  return fields
}

export default (t) => {
  const service = read(SERVICE)
  const ui = read(UI)
  const methods = methodNames(service)
  const fields = statusFields(service)

  t.suite('契约：UI 调用的 listenTogether.* 方法都必须在 service 里存在', () => {
    const used = new Set()
    const re = /listenTogether\.([a-zA-Z_$][\w$]*)/g
    let match
    while ((match = re.exec(ui)) !== null) used.add(match[1])
    t.ok(used.size > 0, 'UI 至少调用了几个方法')
    const missing = [...used].filter(name => !methods.has(name))
    t.eq(missing, [], `缺失的方法：${missing.join(', ')}`)
  })

  t.suite('契约：UI 读的 status.* 字段都必须在 RoomStatus 里声明', () => {
    const used = new Set()
    const re = /status\.([a-zA-Z_$][\w$]*)/g
    let match
    while ((match = re.exec(ui)) !== null) used.add(match[1])
    t.ok(used.size > 0, 'UI 至少读了几个字段')
    const missing = [...used].filter(name => !fields.has(name))
    t.eq(missing, [], `未声明的字段：${missing.join(', ')}`)
  })

  t.suite('契约：status 里的字段在初始状态里都要有值（避免 undefined 崩 UI）', () => {
    const initStart = service.indexOf('private status: RoomStatus = {')
    const initEnd = service.indexOf('}', initStart)
    const init = service.slice(initStart, initEnd)
    const missing = [...fields].filter(field => !new RegExp(`\\b${field}\\s*:`).test(init))
    t.eq(missing, [], `初始状态缺字段：${missing.join(', ')}`)
  })

  t.suite('契约：面板有错误边界（任何渲染异常都不能拖垮设置页）', () => {
    t.ok(ui.includes('PanelBoundary'), '有 PanelBoundary')
    t.ok(ui.includes('getDerivedStateFromError'), '实现了错误捕获')
  })
}
