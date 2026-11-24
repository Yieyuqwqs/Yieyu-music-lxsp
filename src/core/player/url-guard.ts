/**
 * 播放前链接校验（宪法第一条：把缺陷修在产生缺陷的那一层）
 *
 * 根因：解析器返回的直链可能是过期/被拒的（日志实测 ExoPlayer 拿到 403、或 205ms 伪时长的空流），
 *      播放器仍会"加载 → 立刻结束 → 自动下一首"，表现是 state 3/6/8/0 循环 + 00:00。
 * 修法：链接在交给播放器之前必须过一次真实字节探测，不通过就不播、走解析器的重试/报错链路。
 */
const TIMEOUT_MS = 2500
const MIN_BYTES = 512

export const isPlayableMediaUrl = async(url: string): Promise<boolean> => {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null
  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
      signal: controller?.signal,
    })
    const buffer = await response.arrayBuffer()
    const type = response.headers.get('content-type') ?? ''
    const usable = (response.status === 200 || response.status === 206) &&
      buffer.byteLength >= MIN_BYTES &&
      !/text\/html/i.test(type)
    return usable
  } catch (error) {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}
