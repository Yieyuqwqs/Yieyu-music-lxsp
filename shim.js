global.Buffer = require('buffer').Buffer

// 全局兜底：容器/定时退出这类模块在极端时序下可能拿到 undefined，
// 只吞掉已知的这一条，其余错误仍交给 RN 默认处理（红屏）
try {
  const previousHandler = global.ErrorUtils?.getGlobalHandler?.()
  global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    const message = String(error?.message ?? error ?? '')
    if (
      message.includes('onTimeUpdate') ||
      message.includes("Property 'ReturnType' doesn't exist") ||
      message.includes('Property \'ReturnType\'')
    ) {
      console.warn('[Yieyu] swallowed known fatal:', message)
      return
    }
    if (previousHandler) previousHandler(error, isFatal)
  })
} catch (error) {
  console.warn('global handler install failed', error)
}
