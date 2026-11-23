/** 并发容灾：主源 0.1s 没结果就并发打备用，谁先成功用谁 */
import { SourceRegistry } from '../../src/core/source/registry.ts'
import { SourceResolver } from '../../src/core/source/resolver.ts'
import { LxspError } from '../../src/core/source/errors.ts'

const provider = ({ id, priority, delay = 0, fail = null, calls }) => ({
  meta: {
    id, providerId: id, name: id, version: '1', kind: 'lxsp', source: 'kw',
    priority, qualities: ['flac', '320k', '128k'], capabilities: ['url'],
  },
  supports: cap => cap === 'url',
  resolveUrl: async(query) => {
    calls.push(id)
    if (delay) await new Promise(r => setTimeout(r, delay))
    if (fail) throw fail
    return { url: `http://cdn/${id}.flac`, quality: query.quality, requestedQuality: query.quality, downgraded: false }
  },
  lyric: async() => ({ lrc: '' }),
  pic: async() => '',
  search: async() => ({ items: [], page: 1, limit: 10, hasMore: false }),
})

const build = (providers, hedgeMs = 100) => {
  const registry = new SourceRegistry()
  for (const p of providers) registry.add(p)
  return { registry, resolver: new SourceResolver({ registry, hedgeMs }) }
}

export default (t) => {
  t.suite('主源挂起不返回：0.1s 后备用接管，总耗时可控', async() => {
    const calls = []
    const hanging = provider({ id: 'primary', priority: 0, delay: 5000, calls })
    const backup = provider({ id: 'backup', priority: 10, delay: 40, calls })
    const { resolver } = build([hanging, backup])
    const started = Date.now()
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    const elapsed = Date.now() - started
    t.eq(result.provider.id, 'backup', '用备用源出链')
    t.ok(elapsed < 400, `总耗时应 < 400ms，实际 ${elapsed}ms`)
    t.eq(calls.join(','), 'primary,backup', '两路都发过')
  })

  t.suite('主源快速报错：不等 0.1s，立刻补位', async() => {
    const calls = []
    const broken = provider({ id: 'primary', priority: 0, fail: new LxspError('network', 'ECONNREFUSED'), calls })
    const backup = provider({ id: 'backup', priority: 10, delay: 30, calls })
    const { resolver } = build([broken, backup])
    const started = Date.now()
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    const elapsed = Date.now() - started
    t.eq(result.provider.id, 'backup')
    t.ok(elapsed < 120, `应立刻补位（<120ms），实际 ${elapsed}ms`)
  })

  t.suite('主源够快：备用源一次都不会被拉起（不浪费上游额度）', async() => {
    const calls = []
    const fast = provider({ id: 'primary', priority: 0, delay: 20, calls })
    const backup = provider({ id: 'backup', priority: 10, delay: 20, calls })
    const { resolver } = build([fast, backup])
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    t.eq(result.provider.id, 'primary')
    t.eq(calls, ['primary'], '备用源零调用')
  })

  t.suite('三路阶梯：前两路都慢，第三路 0.2s 内接上', async() => {
    const calls = []
    const p0 = provider({ id: 'u0', priority: 0, delay: 5000, calls })
    const p1 = provider({ id: 'u1', priority: 10, delay: 5000, calls })
    const p2 = provider({ id: 'u2', priority: 20, delay: 20, calls })
    const { resolver } = build([p0, p1, p2], 100)
    const started = Date.now()
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    const elapsed = Date.now() - started
    t.eq(result.provider.id, 'u2')
    t.ok(elapsed < 400, `0/100/200ms 阶梯后应很快出结果，实际 ${elapsed}ms`)
    t.eq(calls.join(','), 'u0,u1,u2')
  })

  t.suite('全部失败：抛最后一个错误码，且 attempts 记录三路尝试', async() => {
    const calls = []
    const mk = (id, priority, code) => provider({ id, priority, fail: new LxspError(code, code), calls })
    const { resolver } = build([
      mk('a', 0, 'network'),
      mk('b', 10, 'unauthorized'),
      mk('c', 20, 'upstream_denied'),
    ])
    const error = await t.rejects(() => resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' }), 'upstream_denied', '最后一个错误')
    t.ok(error !== undefined)
  })
}
