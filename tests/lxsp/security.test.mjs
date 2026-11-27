/**
 * 安全策略：端点地址 / 密钥暴露面 / 日志脱敏
 *
 * 由来（真机截图 + 网关日志实测）：
 *   lx-source 族只认 `?key=`（header / bearer 实测都是 403），所以密钥必然出现在 URL 里；
 *   而旧版客户端还把同一个密钥同时塞进 X-Api-Key、Authorization 和 ?key=，
 *   于是「公网 http + 三处齐发」等于把密钥明文广播出去，网关日志也原样打印。
 *
 * 这一组断言守的是：
 *   · 公网明文 http 端点直接拒绝（本机/局域网允许）；
 *   · 每个请求只发一种凭据；
 *   · 日志里的 URL 必须脱敏；
 *   · APK 不再内置任何默认密钥。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkEndpointSecurity, hostOf, isPrivateHost, redactUrl } from '../../src/core/source/protocol.ts'
import { SourceEngine } from '../../src/core/source/engine.ts'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

const SECRET = 'Cyb-P2077-n30h4ck3r-0X'

export default (t) => {
  t.suite('安全：主机识别（含端口与 IPv6）', () => {
    t.eq(hostOf('https://c.wwwweb.top/music/url'), 'c.wwwweb.top', '取 host 不带路径')
    t.eq(hostOf('http://127.0.0.1:1101/api/v0/'), '127.0.0.1', '去掉端口')
    t.eq(hostOf('http://[::1]:8080/x'), '[::1]', 'IPv6 方括号要保留')
    t.eq(hostOf('not-a-url'), '', '非法地址返回空串')
  })

  t.suite('安全：本机/局域网判定', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '192.168.1.5', '10.0.0.7', '172.20.3.4', '169.254.1.1', 'nas.local', 'printer.lan']) {
      t.ok(isPrivateHost(host), `${host} 必须算内网`)
    }
    for (const host of ['8.8.8.8', 'c.wwwweb.top', '172.32.0.1', '172.15.0.1', '113.1.2.3']) {
      t.ok(!isPrivateHost(host), `${host} 必须算公网`)
    }
  })

  t.suite('安全：公网明文 http 必须拒绝，本机/局域网放行', () => {
    const https = checkEndpointSecurity('https://c.wwwweb.top')
    t.eq(https.level, 'secure', 'https 公网 = secure')
    t.ok(https.ok, 'https 必须放行')

    const local = checkEndpointSecurity('http://127.0.0.1:1101')
    t.eq(local.level, 'local', '本机 http = local')
    t.ok(local.ok, '本机 http 必须放行（密钥只在本机内传输）')

    const lan = checkEndpointSecurity('http://192.168.1.5:8080')
    t.ok(lan.ok, '局域网 http 必须放行')

    const bad = checkEndpointSecurity('http://gw.example.com')
    t.eq(bad.level, 'insecure', '公网 http = insecure')
    t.ok(!bad.ok, '公网明文必须拒绝')
    t.ok(!!bad.reason && bad.reason.includes('https'), '拒绝原因必须给出可操作的下一步（改 https）')

    t.eq(checkEndpointSecurity('ftp://x').level, 'invalid', '非 http(s) 视为非法')
    t.eq(checkEndpointSecurity('').ok, false, '空地址不放行')
  })

  t.suite('安全：日志脱敏（密钥不许进 logcat）', () => {
    t.eq(redactUrl(`http://127.0.0.1:1101/api/v0/url/kw/1/320k?key=${SECRET}`), 'http://127.0.0.1:1101/api/v0/url/kw/1/320k?key=***', '?key= 必须被打码')
    t.eq(redactUrl('http://h/api?quality=flac&key=abc&page=1'), 'http://h/api?quality=flac&key=***&page=1', '其他参数保持不变')
    t.eq(redactUrl('http://h/api?Api-Key=abc'), 'http://h/api?Api-Key=***', '大小写与短横线都要覆盖')
    t.eq(redactUrl('http://h/api?token=abc&apikey=def'), 'http://h/api?token=***&apikey=***', '多种密钥参数名都要覆盖')
    t.eq(redactUrl('http://h/api'), 'http://h/api', '没有查询串时原样返回')
  })

  t.suite('安全：引擎在发请求前就拦掉公网明文端点', async() => {
    let fetched = 0
    const engine = new SourceEngine()
    const result = await engine.init({
      endpoints: [{ baseUrl: 'http://gw.example.com:8080' }],
      fetchImpl: () => { fetched += 1; return Promise.resolve({ status: 500, ok: false, headers: { get: () => null }, text: async() => '' }) },
      timeoutMs: 300,
    })
    t.eq(result.endpointStatus?.length ?? result.endpoints.length, 1, '端点状态要如实返回')
    const status = result.endpoints[0]
    t.ok(!status.ok, '公网明文端点必须判为不可用')
    t.ok(!!status.error && status.error.includes('安全策略'), `错误必须说明是安全策略，实际：${status.error}`)
    t.eq(fetched, 0, '被安全策略拦下时一个请求都不许发出去')
  })

  t.suite('安全：静态契约（凭据只发一种 / 默认密钥已移除）', () => {
    const profiles = read('src/core/source/api-profiles.ts')
    t.ok(!profiles.includes("auth: 'both'"), '不许再有三处齐发的 both 模式')
    t.ok(!/auth === 'both'/.test(profiles), 'callApi 里不许再保留 both 分支')
    const queryCount = (profiles.match(/auth: 'query'/g) || []).length
    t.ok(queryCount >= 3, `lx-source 族（探测+直链+歌词+封面）必须走 query，实际 ${queryCount} 处`)
    const headerCount = (profiles.match(/auth: 'header'/g) || []).length
    t.ok(headerCount >= 3, `wwwweb/json 族必须走 header，实际 ${headerCount} 处`)

    const defaults = read('src/config/defaultSetting.ts')
    t.ok(!defaults.includes(SECRET), '默认设置里不许再内置任何密钥')
    t.ok(/['"]common\.lxspToken['"]:\s*''/.test(defaults), '默认密钥必须是空串')
    const allSrc = ['src/config/defaultSetting.ts', 'src/core/source/api-profiles.ts', 'src/screens/Home/Views/Setting/settings/Basic/Source.tsx']
      .map(read).join('\n')
    t.ok(!allSrc.includes(SECRET), '源码里不许再出现那把真实密钥')
  })
}
