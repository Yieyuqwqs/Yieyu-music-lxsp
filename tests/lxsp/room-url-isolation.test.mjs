/**
 * 一起听的结构不变量：成员端不许把「房间给的直链」直接交给播放器
 *
 * 根因：曾用 preloadNextTrack() 把房主的直链塞进本机 TrackPlayer 队列做预缓冲。
 * 那条链是房主解析的，签名/IP 绑定房主网络，成员端拿到往往是死链；
 * 而且它让「成员一律本机解析」这条结构规则名存实亡。
 * 修复方式是把预缓冲整块删掉（宪法第七条：不留半成品），这里用静态断言钉住，
 * 防止以后有人再把它加回来。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const DIR = REPO + 'src/core/listen-together/'
const files = readdirSync(DIR).filter(name => name.endsWith('.ts'))
const sources = files.map(name => [name, readFileSync(DIR + name, 'utf8')])

const hits = pattern => sources
  .filter(([, text]) => pattern.test(text))
  .map(([name]) => name)

export default (t) => {
  t.suite('结构不变量：一起听模块不得自己往播放器队列塞/删轨', () => {
    t.eq(hits(/TrackPlayer\.(add|remove)\(/), [], '只允许「读」播放器状态，加轨/删轨必须走 App 管线')
  })

  t.suite('结构不变量：预缓冲轨与房间直链预加载不得复活', () => {
    t.eq(hits(/lxp2p_preload/), [], '预缓冲轨前缀必须绝迹')
    t.eq(hits(/url:\s*track\.url/), [], '房间直链不得被塞进播放器轨对象')
  })

  t.suite('结构不变量：预缓冲开关必须连设置项一起消失（不留无消费者的开关）', () => {
    t.eq(hits(/listenTogetherPrebuffer/), [], '一起听模块里不该再有这个键')
    const settings = readFileSync(REPO + 'src/config/defaultSetting.ts', 'utf8')
    t.eq(settings.includes('listenTogetherPrebuffer'), false, '默认设置里不许残留空开关')
    const types = REPO + 'src/types/app_setting.d.ts'
    t.eq(existsSync(types) && readFileSync(types, 'utf8').includes('listenTogetherPrebuffer'), false, '类型定义里不许残留空开关')
  })

  t.suite('结构不变量：遥测层不许自带定时器（宪法第一条：定时器不是修复手段）', () => {
    const telemetry = readFileSync(DIR + 'telemetry.ts', 'utf8')
    t.eq(/setInterval\(/.test(telemetry), false, '遥测只准在事件里记录，不准周期性采样')
  })
}
