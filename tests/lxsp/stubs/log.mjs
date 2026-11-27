// node 侧的日志桩（测试专用）
// 真实 src/utils/log.ts 会落盘到 RN 文件系统，node 下没有该语义；
// 这里只保留同名调用面，便于 node 里直接跑业务模块。
const sink = []
export const __logSink = sink
const push = (type) => (...args) => { sink.push({ type, args }) }
export const log = { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
export const init = async() => {}
export const getLogs = async() => ''
export default log
