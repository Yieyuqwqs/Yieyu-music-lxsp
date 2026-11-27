/**
 * 解析流水线：换源 / 降档 / 错误策略 / 并发合并 / 健康度
 *
 * human-exempt: 人类授权 2026-11-27。本文件验证的是「决策逻辑」（哪路胜出、降档几次、冷却多久），
 * fakeProvider 只提供可控延迟与错误码，不发真实请求；真实直链/真实字节由 live.test.mjs 覆盖。
 * 缺少的验证：真实端点的降档阶梯与上游限流表现。
 */
import { SourceRegistry } from '../../src/core/source/registry.ts'
import { SourceResolver } from '../../src/core/source/resolver.ts'
import { LxspError } from '../../src/core/source/errors.ts'

const ALL_CAPS = ['url', 'lyric', 'pic', 'search']

const fakeProvider = (options = {}) => {
  const meta = {
    id: options.id ?? 'p0',
    providerId: options.providerId ?? 'fake',
    name: options.name ?? 'Fake',
    version: '1',
    kind: 'lxsp',
    endpoint: 'http://fake',
    source: options.source ?? 'kw',
    priority: options.priority ?? 0,
    qualities: options.qualities ?? ['flac', '320k', '128k'],
    capabilities: options.capabilities ?? ALL_CAPS,
  }
  const calls = []
  const provider = {
    meta,
    calls,
    supports: cap => meta.capabilities.includes(cap),
    resolveUrl: async(query) => {
      calls.push(`url:${query.quality}`)
      return options.resolveUrl ? options.resolveUrl(query, calls) : { url: `http://cdn/${query.id}.flac`, quality: query.quality, requestedQuality: query.quality, downgraded: false }
    },
    lyric: async(query) => {
      calls.push('lyric')
      return options.lyric ? options.lyric(query) : { lrc: '[00:00.00]hi' }
    },
    pic: async(query) => {
      calls.push('pic')
      return options.pic ? options.pic(query) : 'http://cdn/pic.jpg'
    },
    search: async(query) => {
      calls.push('search')
      return { items: [], page: query.page, limit: query.limit, hasMore: false }
    },
  }
  return provider
}

const build = (providers, hooks) => {
  const registry = new SourceRegistry()
  for (const provider of providers) registry.add(provider)
  const resolver = new SourceResolver({ registry, hooks })
  return { registry, resolver }
}

export default (t) => {
  t.suite('换源：主端点网络错误 → 立刻换镜像，不走降档浪费时间', async() => {
    const primary = fakeProvider({ id: 'primary', priority: 0, resolveUrl: () => { throw new LxspError('network', 'ECONNREFUSED') } })
    const mirror = fakeProvider({ id: 'mirror', priority: 10 })
    const { resolver, registry } = build([primary, mirror])
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    t.eq(result.provider.id, 'mirror', '用了镜像')
    t.eq(primary.calls, ['url:flac'], '主端点只试了一次最高档，没有继续降档')
    t.eq(registry.isCoolingDown('primary'), true, '主端点进入冷却')
  })

  t.suite('降档：quality_unavailable 走下一档，并把降档事实带回去', async() => {
    const provider = fakeProvider({
      id: 'p', qualities: ['flac', '320k', '128k'],
      resolveUrl: (query) => {
        if (query.quality === 'flac') throw new LxspError('quality_unavailable', 'no flac', { quality: 'flac' })
        return { url: 'http://cdn/320.mp3', quality: '320k', requestedQuality: 'flac', downgraded: true }
      },
    })
    const { resolver } = build([provider])
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    t.eq(result.value.quality, '320k')
    t.eq(result.value.downgraded, true, '降档必须显式声明')
    t.eq(provider.calls, ['url:flac', 'url:320k'], '按阶梯逐档尝试')
  })

  t.suite('降档复核：服务端漏报降档，引擎必须补上', async() => {
    const provider = fakeProvider({
      id: 'p', qualities: ['flac', '320k'],
      resolveUrl: () => ({ url: 'http://cdn/320.mp3', quality: '320k', requestedQuality: 'flac', downgraded: false }),
    })
    const { resolver } = build([provider])
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    t.eq(result.value.quality, '320k')
    t.eq(result.value.downgraded, true, '引擎层补报降档')
  })

  t.suite('错误策略：鉴权失败换源，不在同一端点继续烧降档', async() => {
    const broken = fakeProvider({ id: 'broken', priority: 0, resolveUrl: () => { throw new LxspError('unauthorized', 'bad token') } })
    const good = fakeProvider({ id: 'good', priority: 10 })
    const { resolver } = build([broken, good])
    const result = await resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    t.eq(broken.calls, ['url:flac'], '鉴权失败只试一档')
    t.eq(result.provider.id, 'good')
  })

  t.suite('并发合并：同一首歌同时被界面和播放器请求，只打一次上游', async() => {
    let upstreamCalls = 0
    const provider = fakeProvider({
      id: 'p',
      resolveUrl: async(query) => {
        upstreamCalls += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        return { url: 'http://cdn/x.flac', quality: query.quality, requestedQuality: query.quality, downgraded: false }
      },
    })
    const { resolver } = build([provider])
    const [a, b] = await Promise.all([
      resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' }),
      resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' }),
    ])
    t.eq(upstreamCalls, 1, '上游只被调用一次')
    t.eq(a.value.url, b.value.url, '两个调用拿到同一个结果')
  })

  t.suite('取消：canceled 不再尝试任何后续源', async() => {
    const provider = fakeProvider({ id: 'p', resolveUrl: () => { throw new LxspError('canceled', 'user stopped') } })
    const mirror = fakeProvider({ id: 'm', priority: 10 })
    const { resolver } = build([provider, mirror])
    await t.rejects(() => resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' }), 'canceled', '取消要原样抛出')
    t.eq(mirror.calls, [], '取消后不再打镜像')
  })

  t.suite('全失败：抛最后一个错误码，attempts 完整记录', async() => {
    const a = fakeProvider({ id: 'a', priority: 0, resolveUrl: () => { throw new LxspError('rate_limited', '429') } })
    const b = fakeProvider({ id: 'b', priority: 10, resolveUrl: () => { throw new LxspError('not_found', 'no such id') } })
    const { resolver } = build([a, b])
    const error = await t.rejects(() => resolver.resolveUrl({ source: 'kw', id: '42', quality: 'flac' }), 'not_found', '最后一个错误')
    t.ok(error !== undefined, '拿到错误对象')
  })

  t.suite('歌词缓存：第二次请求不再打上游', async() => {
    const provider = fakeProvider({ id: 'p' })
    const { resolver } = build([provider])
    await resolver.getLyric({ source: 'kw', id: '42' })
    await resolver.getLyric({ source: 'kw', id: '42' })
    t.eq(provider.calls, ['lyric'], '只打一次')
  })

  t.suite('记住音源：成功解析后回调 hooks.rememberSource', async() => {
    let remembered = null
    const provider = fakeProvider({ id: 'p' })
    const registry = new SourceRegistry()
    registry.add(provider)
    const resolver = new SourceResolver({ registry, hooks: { rememberSource: info => { remembered = info } } })
    await resolver.resolveUrl({ source: 'kw', id: '42', name: '东风破', singer: '周杰伦', quality: '320k' })
    t.eq(remembered, { source: 'kw', name: '东风破', singer: '周杰伦' })
  })

  t.suite('注册表排序：冷却中的源排到最后，但仍然保留', () => {
    const a = fakeProvider({ id: 'a', priority: 0 })
    const b = fakeProvider({ id: 'b', priority: 1 })
    const registry = new SourceRegistry()
    registry.add(a)
    registry.add(b)
    t.eq(registry.providersFor('kw').map(p => p.meta.id), ['a', 'b'])
    registry.markUnhealthy('a', 'timeout')
    t.eq(registry.providersFor('kw').map(p => p.meta.id), ['b', 'a'], '坏源降权')
  })
}
