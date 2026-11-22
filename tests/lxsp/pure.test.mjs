/** 纯逻辑：音质阶梯、别名归一、降档候选、manifest 校验 */
import { normalizeQuality, pickCandidates, sortQualitiesDesc, isDowngrade, qualityRank } from '../../src/core/source/quality.ts'
import { parseManifest, declaredCapabilities, toQualityList } from '../../src/core/source/manifest.ts'
import { TtlCache, Singleflight } from '../../src/core/source/cache.ts'

const VALID_MANIFEST = {
  lxsp: '2.0',
  provider: { id: 'yieyu-gw', name: 'Yieyu Gateway', version: '1.2.3' },
  capabilities: ['url', 'lyric', 'pic', 'search'],
  features: { streamProxy: true, crossSource: true },
  limits: { timeoutMs: 9000, maxPageSize: 40, urlTtlS: 1800 },
  sources: [
    { key: 'kw', name: '酷我音乐', qualities: ['sq', '128k', '320k'], idFormat: 'uint' },
    { key: 'kg', name: '酷狗音乐', qualities: ['flac24bit', 'flac', '320k', '128k'], capabilities: ['url', 'lyric'] },
  ],
}

export default (t) => {
  t.suite('音质别名归一：sq/hq/lossless 这类自造词汇必须落到规范词汇', () => {
    t.eq(normalizeQuality('sq'), 'flac', 'sq → flac')
    t.eq(normalizeQuality('HQ'), '320k', '大写 HQ → 320k')
    t.eq(normalizeQuality('lossless_24bit'), 'flac24bit', 'lossless_24bit → flac24bit')
    t.eq(normalizeQuality('master'), 'master', 'master 原样')
    t.eq(normalizeQuality('44.1khz'), null, '无法识别 → null')
    t.eq(normalizeQuality(undefined), null, 'undefined → null')
  })

  t.suite('音质阶梯排序：母带 > 全景声 > 无损 > 320k > 128k', () => {
    t.eq(sortQualitiesDesc(['128k', 'master', 'flac', '320k', 'atmos']), ['master', 'atmos', 'flac', '320k', '128k'])
    t.eq(qualityRank('flac') < qualityRank('320k'), true, 'flac 优于 320k')
  })

  t.suite('候选音质：从设置档位向下降档，只取真实存在的', () => {
    t.eq(pickCandidates('flac', ['128k', '320k', 'flac', 'flac24bit']), ['flac', '320k', '128k'])
    t.eq(pickCandidates('auto', ['320k', '128k']), ['320k', '128k'], 'auto 从最高开始')
    t.eq(pickCandidates('master', ['128k']), ['128k'], '设置高于源上限时降档')
    t.eq(pickCandidates('flac', []), ['128k'], '无声明时兜底 128k')
  })

  t.suite('降档判定：auto 不算降档，服务端给差的必须识别出来', () => {
    t.eq(isDowngrade('flac', '320k'), true, 'flac → 320k 是降档')
    t.eq(isDowngrade('320k', 'flac'), false, '320k → flac 不是降档')
    t.eq(isDowngrade('auto', '128k'), false, 'auto 不判定')
  })

  t.suite('manifest 解析：合法声明被归一（音质别名、能力继承）', () => {
    const manifest = parseManifest(VALID_MANIFEST)
    t.eq(manifest.provider.id, 'yieyu-gw')
    t.eq(manifest.sources[0].qualities, ['flac', '320k', '128k'], 'kw 的 sq 被归一为 flac 并降序')
    t.eq(declaredCapabilities(manifest, 'kw'), ['url', 'lyric', 'pic', 'search'], '继承全局能力')
    t.eq(declaredCapabilities(manifest, 'kg'), ['url', 'lyric'], '源内声明覆盖全局')
    t.eq(manifest.limits.timeoutMs, 9000)
    t.eq(toQualityList(manifest).kw, ['flac', '320k', '128k'], 'qualityList 投影只保留 LX 词汇')
  })

  t.suite('manifest 校验：版本/音源/音质不合法必须硬失败，不许猜', async() => {
    await t.rejects(() => parseManifest({ ...VALID_MANIFEST, lxsp: '1.0' }), 'bad_response', '主版本不符')
    await t.rejects(() => parseManifest({ ...VALID_MANIFEST, sources: [{ key: 'xx', name: 'X', qualities: ['128k'] }] }), 'bad_response', '未知音源')
    await t.rejects(() => parseManifest({ ...VALID_MANIFEST, sources: [{ key: 'kw', name: 'K', qualities: ['hires_x'] }] }), 'bad_response', '无可识别音质')
    await t.rejects(() => parseManifest({ ...VALID_MANIFEST, sources: [VALID_MANIFEST.sources[0], VALID_MANIFEST.sources[0]] }), 'bad_response', '重复音源')
    await t.rejects(() => parseManifest({ ...VALID_MANIFEST, provider: { name: 'x' } }), 'bad_response', '缺 provider.id')
    await t.rejects(() => parseManifest(null), 'bad_response', 'null')
  })

  t.suite('TTL 缓存：过期即失效，LRU 超限淘汰最旧', () => {
    let now = 1000
    const cache = new TtlCache({ max: 2, ttlMs: 100, now: () => now })
    cache.set('a', 1)
    cache.set('b', 2)
    t.eq(cache.get('a'), 1)
    now += 101
    t.eq(cache.get('a'), undefined, '过期后取不到')
    cache.set('c', 3)
    cache.set('d', 4)
    t.eq(cache.size, 2, '超过 max 后淘汰')
  })

  t.suite('singleflight：同 key 并发只跑一次，结果广播', async() => {
    const flight = new Singleflight()
    let calls = 0
    const task = () => new Promise(resolve => {
      calls += 1
      setTimeout(() => resolve('v'), 20)
    })
    const [a, b, c] = await Promise.all([flight.run('k', task), flight.run('k', task), flight.run('k', task)])
    t.eq([a, b, c], ['v', 'v', 'v'], '三个等待者拿到同一结果')
    t.eq(calls, 1, '任务只执行一次')
    t.eq(flight.size, 0, '结束后清空')
  })
}
