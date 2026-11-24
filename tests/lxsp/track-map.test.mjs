/** 房间曲目 ↔ 本机曲目匹配 */
import { stableKeyOfMusicInfo, isSameSong, pickBestTrack } from '../../src/core/listen-together/track-map.ts'

const target = { stableKey: 'kw:42', id: '42', source: 'kw', name: '东风破', singer: '周杰伦', durationMs: 313_000 }

const info = (over) => ({
  id: over.id ?? 'kw_42', source: over.source ?? 'kw', name: over.name ?? '东风破', singer: over.singer ?? '周杰伦',
  meta: { songId: over.songId ?? '42' },
})

export default (t) => {
  t.suite('稳定键：优先 meta.songId，兼容带前缀的老 id', () => {
    t.eq(stableKeyOfMusicInfo({ id: 'kw_42', source: 'kw', meta: { songId: '42' } }), 'kw:42')
    t.eq(stableKeyOfMusicInfo({ id: 'kw_42', source: 'kw' }), 'kw:42', '没有 meta 时剥离前缀')
    t.eq(stableKeyOfMusicInfo({ id: '42', source: 'kw' }), 'kw:42')
    t.eq(stableKeyOfMusicInfo(null), '')
  })

  t.suite('同名同歌手判定：标点/空格/多歌手都不影响', () => {
    t.eq(isSameSong(info({}), target), true)
    t.eq(isSameSong(info({ singer: '周杰伦、方文山' }), target), true, '多歌手里包含即可')
    t.eq(isSameSong(info({ name: '东风破 (Live)' }), target), false, '版本名不同不算（靠同名兜底）')
    t.eq(isSameSong(info({ singer: '费玉清' }), target), false)
  })

  t.suite('挑曲目：精确键优先 → 同名同歌手 → 只同名', () => {
    const other = info({ id: 'kw_9', songId: '9', name: '别的歌', singer: '别人' })
    const byKey = pickBestTrack([other, info({})], target)
    t.eq(stableKeyOfMusicInfo(byKey), 'kw:42', '精确命中')

    const crossSource = info({ id: 'kg_777', source: 'kg', songId: '777' })
    const bySong = pickBestTrack([other, crossSource], target)
    t.eq(bySong?.source, 'kg', '跨平台靠歌名+歌手兜底')

    const onlyName = info({ id: 'tx_5', source: 'tx', songId: '5', singer: '未知' })
    t.eq(pickBestTrack([other, onlyName], target)?.source, 'tx', '只同名也接受')
    t.eq(pickBestTrack([], target), null)
    t.eq(pickBestTrack([other], target), null)
  })
}
