/**
 * 给任意 Promise 套一个超时：超时返回 fallback，**绝不悬挂**。
 *
 * 用途：可视化每次取帧都要跨 RN 桥调原生。卡顿/原生队列拥塞时那个 Promise 可能永远不 settle，
 * 一旦 await 它，整个取帧循环就永久停摆（用户看到的就是"柱子没了，怎么点都不回来"）。
 */
export const raceTimeout = async <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(0, ms))
      }),
    ])
  } catch (error) {
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}
