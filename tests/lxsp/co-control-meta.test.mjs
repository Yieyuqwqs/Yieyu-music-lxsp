/**
 * 两条结构不变量（2026-11-25 用户反馈驱动）：
 *
 * 1. 房间换歌后不能丢封面/歌词
 *    根因：封面与歌词只在 handleRestorePlay / debouncePlay 里加载，一起听直接调
 *    setMusicUrl 就绕过了它们。修法是把加载收敛成唯一出口 loadMusicMeta()，
 *    并要求每一条一起听切歌路径都调用它。
 *
 * 2. 播放/暂停/进度两个人都能按，但状态仍只有房主能写
 *    成员按下 → CMD 消息 → 房主执行 → 广播；切歌/改模式仍归房主。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const read = rel => readFileSync(REPO + rel, 'utf8')
const count = (text, re) => (text.match(re) || []).length

export default (t) => {
  t.suite('封面与歌词：只允许一个加载出口 loadMusicMeta', () => {
    const player = read('src/core/player/player.ts')
    t.ok(/export const loadMusicMeta = /.test(player), '出口必须被导出（一起听才能调）')
    t.eq(count(player, /void getPicPath\(\{/g), 1, '封面加载只准有一处实现')
    t.eq(count(player, /void getLyricInfo\(\{/g), 1, '歌词加载只准有一处实现')
  })

  t.suite('封面与歌词：一起听的每条切歌路径都要调用它', () => {
    const svc = read('src/core/listen-together/service.ts')
    const calls = count(svc, /loadMusicMeta\(/g)
    t.ok(calls >= 3, `三条切歌路径都得带封面/歌词加载，实际 ${calls} 处`)
    t.ok(/from '@\/core\/player\/player'/.test(svc), '必须从播放器模块导入，不许自己实现一套')
  })

  t.suite('协作控制：成员可发播放/暂停/进度，切歌与改模式不进白名单', () => {
    const p2p = read('src/core/listen-together/p2p-room.ts')
    const allow = /const CO_CONTROL: Record<string, string> = \{([^}]*)\}/.exec(p2p)
    t.ok(Boolean(allow), '必须有显式白名单常量（不允许「谁都能发任何命令」）')
    const list = allow[1]
    for (const cmd of ['PLAY', 'PAUSE', 'SEEK']) t.ok(list.includes(cmd), `白名单包含 ${cmd}`)
    for (const bad of ['SET_TRACK', 'QUEUE_ADD', 'PLAYBACK_MODE']) {
      t.eq(list.includes(bad), false, `白名单不许包含 ${bad}（队列语义只有房主能动）`)
    }
    t.ok(/command\(type: 'PLAY' \| 'PAUSE' \| 'SEEK'/.test(p2p), '成员侧入口只接受三种控制')
    t.ok(/type: 'CMD'/.test(p2p), '成员发的是 CMD 消息，由房主执行后广播')
  })

  t.suite('协作控制：房主仍是唯一写入方', () => {
    const p2p = read('src/core/listen-together/p2p-room.ts')
    t.ok(/if \(this\.role === 'host' && message\.type === 'CMD'\)/.test(p2p), '只有房主处理 CMD')
    t.ok(/if \(this\.applyControl\(type, payload as never\)\) this\.broadcastState\(\)/.test(p2p), '状态写入仍走 control() → 广播')
  })
}
