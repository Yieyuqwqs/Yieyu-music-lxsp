/**
 * 结构审计（进 CI，反复跑）：检查「一起听」的关键不变量是否还成立。
 *
 * 这些不变量对应已经踩过的真实故障：
 *  - 房间号被对端消息改写 → 房号乱变
 *  - 旧状态覆盖新状态（双 broker 并行导致乱序）→ 加歌后消失
 *  - 切房不原子 → 旧房间还在广播
 *  - STUN 用境外服务器 → 直连永远不生效
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repo = new URL('../../', import.meta.url)
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, repo)), 'utf8')

export default (t) => {
  const room = read('src/core/listen-together/p2p-room.ts')
  const svc = read('src/core/listen-together/service.ts')
  const p2pTs = read('src/utils/nativeModules/p2p.ts')

  t.suite('审计：状态变更必须有版本号（防旧包覆盖）', () => {
    t.ok((room.match(/this\.bumpVersion\(\)/g) || []).length >= 3, 'bumpVersion 至少 3 处')
    t.ok(room.includes('incomingVersion <= (this.state.version'), 'guest 只接受更大版本')
    t.ok(room.includes('v: this.state.version'), '紧凑状态里带版本号')
  })

  t.suite('审计：只有房主能广播状态', () => {
    t.ok(room.includes("if (this.role !== 'host') return"), 'broadcastState 有 host 守卫')
    t.ok(room.includes('publishBoth'), '走双通道发送')
  })

  t.suite('审计：房间号只信本地，不被对端改写', () => {
    t.ok(!/roomId: state\.roomId/.test(svc), 'service 不写 state.roomId')
    t.ok(room.includes("!== this.roomId) return"), 'guest 丢弃其它房间的消息')
  })

  t.suite('审计：切房/离开是原子重置', () => {
    t.ok(svc.includes('teardownSync'), '存在同步 teardown')
    t.ok(/teardownSync\(\)\n\s+const room = new P2PRoom/.test(svc) || svc.indexOf('teardownSync()') < svc.indexOf('installPlayerHooks()'), 'teardown 在建会话/装钩子之前')
    t.ok(svc.includes('const generation = this.generation'), '钩子带代际守卫')
  })

  t.suite('审计：STUN 国内优先且失败轮换', () => {
    t.ok(p2pTs.includes('stun.miwifi.com'), '国内 STUN 在列表里')
    t.ok(p2pTs.includes('preferredStunIndex'), '记住上次成功的服务器')
    t.ok(p2pTs.includes('for (let attempt'), '失败轮换')
  })

  t.suite('审计：心跳不该引发广播', () => {
    t.ok(!/existing\.lastSeenAt = Date\.now\(\)\n\s*this\.broadcastState\(\)/.test(room), 'touchMember 心跳不广播')
  })

  t.suite('审计：失败重试要退避', () => {
    t.ok(svc.includes('resolveFailedAt'), '有解析失败退避表')
  })

  t.suite('宪法：AGENTS.md 必须在仓库根且包含八条铁律', () => {
    const text = read('AGENTS.md')
    t.ok(text.includes('禁止补丁式开发'), '第一条')
    t.ok(text.includes('四件套'), '第二条')
    t.ok(text.includes('状态只有一个来源'), '第三条')
    t.ok(text.includes('引用必须验证'), '第四条')
    t.ok(text.includes('实测数据'), '第五条')
    t.ok(text.includes('只修根因'), '第六条')
    t.ok(text.includes('不许留未完成的临时方案'), '第七条')
    t.ok(text.includes('诚实高于好看'), '第八条')
    t.ok(text.includes('改动清单纪律'), '第九条')
    t.ok(/性质只能是不变量、幂等、结构重构/.test(text), '第九条-禁止清单')
    t.ok(text.includes('CI 必须解析到每一个模块'), '第十条')
    t.ok(text.includes('禁止用正则批量改写源码'), '第十条-禁止正则批量改')
  })

  t.suite('审计：播放器钩子不会被异步清理抹掉（会话代际）', () => {
    const svc = read('src/core/listen-together/service.ts')
    t.ok(svc.includes('private generation = 0'), '存在会话代际')
    t.ok(/teardownSync\(\)\.\n/.test(svc) || svc.indexOf('this.teardownSync()') > 0, 'startP2P 先同步 teardown')
    t.ok(svc.indexOf('this.teardownSync()') < svc.indexOf('this.installPlayerHooks()'), 'teardown 在装钩子之前')
    t.ok(svc.includes('const alive = () => generation === this.generation'), '钩子有过期守卫')
  })

  t.suite('审计：网络状态只有一个真相', () => {
    const svc = read('src/core/listen-together/service.ts')
    const room = read('src/core/listen-together/p2p-room.ts')
    t.ok(!/^\s*direct: \{/m.test(svc), 'RoomStatus 不再有 direct 字段')
    t.ok(/^\s*transport: /m.test(svc), 'RoomStatus 有 transport')
    t.ok(room.includes('private setTransport('), 'P2PRoom 有唯一写入口')
    t.ok((room.match(/this\.transport = /g) || []).length <= 2, 'transport 只在一处赋值')
  })

  t.suite('审计：契约测试在位', () => {
    t.ok(existsSync(fileURLToPath(new URL('./contract-listen-together.test.mjs', import.meta.url))), '契约测试存在')
  })
}
