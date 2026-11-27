// QQ 资料探测（纯前端，免鉴权）
//
// 实测结论（2026-11，国内移动网络）：
//   · 头像：https://q1.qlogo.cn/g?b=qq&nk=<QQ>&s=640  ← 稳定可用（200 image/jpeg）
//   · 昵称：腾讯已经把老的 qzone 接口（users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg）
//          改成必须登录，会回 {"error":{"type":"need login"}}；第三方聚合接口大多挂了。
//          所以这里做成「多来源尝试 + 允许失败」：拿到就展示，拿不到就让管理员靠头像/QQ 核对。
//
// 注意：头像对任何数字都会返回一张图，所以**不能用它证明 QQ 存在**。
// 真正防伪造靠「管理员人工终审」（见 core/license 的授权申请码 + 管理端待审核）。
import { log } from '@/utils/log'

const AVATAR = 'https://q1.qlogo.cn/g?b=qq&nk={qq}&s=640'
const TIMEOUT = 6000

export interface QQProfile {
  qq: string
  avatar: string
  nickname: string
  /** 昵称是从哪个来源拿到的；空串 = 没拿到 */
  source: string
  /** 探测过程中的提示（拿不到昵称时给用户看） */
  note: string
}

export const avatarUrlOf = (qq: string) => AVATAR.replace('{qq}', encodeURIComponent(String(qq ?? '')))

const withTimeout = async(url: string): Promise<string> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 腾讯老接口：_Callback({...}) / portraitCallBack({...}) —— JSONP 去掉外壳再解析 */
const parseJsonp = (text: string): any => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

const tryQzone = async(qq: string): Promise<string> => {
  const text = await withTimeout(`https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?uins=${qq}`)
  const data = parseJsonp(text)
  if (!data || data.error) return ''
  // 老格式：{"123456789":{"nickname":"xxx","portrait":"..."}} 或 {0:{...}}
  const first = data[qq] ?? data[String(Number(qq))] ?? data['0'] ?? data[0]
  const nickname = first?.nickname ?? first?.nick ?? ''
  return typeof nickname === 'string' ? nickname.trim() : ''
}

/** 第三方聚合（多数不稳，纯兜底；失败就算了） */
const tryAggregators = async(qq: string): Promise<{ nickname: string, source: string }> => {
  const sources = [
    [`https://api.oioweb.cn/api/qq/qqname?qq=${qq}`, 'oioweb'],
    [`https://api.jsososo.com/qq/qqinfo?qq=${qq}`, 'jsososo'],
  ]
  for (const [url, name] of sources) {
    try {
      const text = await withTimeout(url)
      const data = parseJsonp(text)
      const nickname = data?.data?.name ?? data?.name ?? data?.nickname ?? ''
      if (typeof nickname === 'string' && nickname.trim()) return { nickname: nickname.trim(), source: name }
    } catch {}
  }
  return { nickname: '', source: '' }
}

/**
 * 查 QQ 资料：头像总能拿到；昵称能拿就拿，拿不到就返回空并给提示。
 * 不做「存在性判定」——那需要登录态，不能瞎编，交给管理员终审。
 */
export const lookupQQ = async(qq: string): Promise<QQProfile> => {
  const avatar = avatarUrlOf(qq)
  let nickname = ''
  let source = ''
  try {
    nickname = await tryQzone(qq)
    if (nickname) source = 'qzone'
  } catch (error) {
    log.warn('[qq] qzone 昵称查询失败：', (error as Error)?.message)
  }
  if (!nickname) {
    const extra = await tryAggregators(qq)
    nickname = extra.nickname
    source = extra.source
  }
  return {
    qq,
    avatar,
    nickname,
    source,
    note: nickname
      ? ''
      : '腾讯的昵称接口现在要求登录，自动查不到昵称；头像已显示，请核对后再确认，管理员会在管理端人工审核。',
  }
}
