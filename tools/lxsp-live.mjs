/**
 * 真机联调脚本：用 App 里的 LXSP 客户端代码打真实的本地网关。
 *
 * 用法：
 *   node --import ./tests/lxsp/hook.mjs tools/lxsp-live.mjs [baseUrl] [token]
 * 默认 http://127.0.0.1:1101 与配置里的本地 key。
 */
import { LxspTransport } from './../src/core/source/transport.ts'
import { RemoteProvider } from './../src/core/source/remote.ts'
import { SourceRegistry } from './../src/core/source/registry.ts'
import { SourceResolver } from './../src/core/source/resolver.ts'
import { parseManifest } from './../src/core/source/manifest.ts'

const baseUrl = process.argv[2] || 'http://127.0.0.1:1101'
const token = process.argv[3] || 'Cyb-P2077-n30h4ck3r-0X'

const main = async() => {
  const transport = new LxspTransport({ baseUrl, token })
  const manifest = parseManifest(await transport.getJson('/manifest'))
  console.log(`提供方: ${manifest.provider.name} v${manifest.provider.version}`)
  console.log(`音源: ${manifest.sources.map(s => `${s.key}(${s.qualities.join('/')})`).join('  ')}`)

  const registry = new SourceRegistry()
  for (const [index, decl] of manifest.sources.entries()) {
    registry.add(new RemoteProvider({ transport, manifest, source: decl, priority: index }))
  }
  const resolver = new SourceResolver({
    registry,
    hooks: { rememberSource: info => console.log(`  记住音源: ${info.source} ${info.name}`) },
  })

  const source = 'kw'
  const id = process.argv[4] || '62355680'
  const started = Date.now()
  const result = await resolver.resolveUrl({ source, id, quality: 'flac', name: '忘情水', singer: '刘德华' })
  console.log(`\n取直链 ${source}/${id}（要 flac）→ ${result.value.quality}${result.value.downgraded ? ' [已降档]' : ''} ${Date.now() - started}ms`)
  console.log(`  url: ${result.value.url.slice(0, 90)}…`)
  console.log(`  via: ${JSON.stringify(result.value.via)}`)
  console.log(`  尝试: ${result.attempts.map(a => `${a.quality}:${a.ok ? 'ok' : a.code}`).join(' → ')}`)

  const searched = await resolver.search(source, '周杰伦', 1, 3)
  console.log(`\n搜索「周杰伦」: ${searched.value.items.map(item => `${item.name}-${item.singer}`).join(' | ')}`)

  const lyric = await resolver.getLyric({ source, id, name: '忘情水', singer: '刘德华' })
  console.log(`歌词: ${lyric.value.lrc.split('\n').slice(0, 2).join(' / ')}`)
}

main().catch((error) => {
  console.error('联调失败:', error.code ?? '', error.message)
  process.exitCode = 1
})
