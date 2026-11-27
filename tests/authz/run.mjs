// 授权协议回归（纯逻辑，不需要 Android）
//
// 跑法：node --import ./tests/authz/hook.mjs tests/authz/run.mjs
//
// 这里守的是「协议不变」：
//   · 设备码派生必须和 C++ 自检向量逐字节一致（两边算法漂了会立刻红）
//   · 白名单/黑名单 JSON 的容错边界
//   · 令牌编解码 + 状态机矩阵
//   · 离线授权串：管理端（node crypto）签 → 客户端（App 里的纯 JS RSA）验
import crypto from 'node:crypto'

import {
  buildOfflineAuthPayload, decodeToken, encodeToken, evaluate, findEntry, fromExpToken, isExpired,
  isValidQQ, maskQQ, normalizeCode, normalizeQQ, packOfflineAuth, parseBlacklist, parseWhitelist,
  statusText, toExpToken, unpackOfflineAuth,
} from '@/core/authz/protocol'
import { rsaVerify } from '@/utils/rsa'

const suites = []
let current = null

const t = {
  suite (name, fn) { suites.push({ name, fn }) },
  eq (actual, expected, label) {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) throw new Error(`${label ?? ''}\n  期望: ${b}\n  实际: ${a}`)
  },
  ok (value, label) { if (!value) throw new Error(`断言失败: ${label ?? ''}`) },
  throws (fn, label) {
    try {
      fn()
    } catch {
      return
    }
    throw new Error(`${label}: 期望抛错，但没有`)
  },
  test (name, fn) { current.tests.push({ name, fn }) },
}

// ------------------------------------------------------------------ 1. 设备码

const sha256Hex = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
/** 参考实现：直接照 docs/AUTHZ.md §1 写一遍，用来对照 C++ */
const referenceDeviceCode = seed =>
  sha256Hex('yieyu-devcode|v3|' + seed).slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1-')

t.suite('设备码', () => {
  t.test('与 C++ 自检向量一致', () => {
    // authz_core.cpp::selfTest() 里写死的就是这个值
    t.eq(referenceDeviceCode('test-seed'), 'ED1D-7DC1-F252-5FBA', '设备码派生漂了')
  })
  t.test('格式固定：16 位十六进制 + 三段横线', () => {
    const code = referenceDeviceCode('and|com.yieyu.music|abcdef1234567890|Xiaomi|M2007J3SC|umi|kona')
    t.ok(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(code), '格式应为 XXXX-XXXX-XXXX-XXXX: ' + code)
  })
  t.test('seed 不同 → 设备码必不相同', () => {
    t.ok(referenceDeviceCode('a') !== referenceDeviceCode('b'), '两种 seed 撞了')
  })
})

// ------------------------------------------------------------------ 2. 到期日 token

t.suite('到期日 token', () => {
  t.test('永久 → 20991231 → 永久', () => {
    t.eq(toExpToken(null), '20991231')
    t.eq(fromExpToken('20991231'), null)
  })
  t.test('ISO → YYYYMMDD → ISO（当天 23:59:59Z）', () => {
    const token = toExpToken('2027-03-05T08:00:00.000Z')
    t.eq(token, '20270305')
    t.eq(fromExpToken(token), '2027-03-05T23:59:59.000Z')
  })
  t.test('非法输入不炸', () => {
    t.eq(fromExpToken('bad'), null)
    t.eq(fromExpToken(''), null)
    t.eq(fromExpToken('00000000'), null)
    t.eq(toExpToken('not-a-date'), '20991231')
  })
})

// ------------------------------------------------------------------ 3. 云端清单

t.suite('云端清单', () => {
  t.test('白名单：坏条目跳过，合法条目归一化', () => {
    const parsed = parseWhitelist(JSON.stringify({
      version: 1,
      updatedAt: '2026-11-27T00:00:00.000Z',
      devices: [
        { k: 'A'.repeat(64), exp: '2027-01-01T00:00:00.000Z' },
        { k: 'too-short', exp: null },
        { k: 'b'.repeat(64), exp: 'not-a-date' },
        'garbage',
        null,
      ],
    }))
    t.ok(parsed, '应当解析成功')
    t.eq(parsed.devices.length, 2, '坏条目应被跳过')
    t.eq(parsed.devices[0].k, 'a'.repeat(64), '条目键应小写归一化')
    t.eq(parsed.devices[1].exp, null, '非法时间应视为永久')
    t.eq(parsed.updatedAt, Date.parse('2026-11-27T00:00:00.000Z'))
  })
  t.test('白名单：结构不对直接 null（不 throw）', () => {
    t.eq(parseWhitelist('{'), null)
    t.eq(parseWhitelist('{"devices": "nope"}'), null)
  })
  t.test('黑名单：只认 64 位十六进制', () => {
    const parsed = parseBlacklist(JSON.stringify({ keys: ['C'.repeat(64), 'nope', 123] }))
    t.eq(parsed.keys, ['c'.repeat(64)])
  })
  t.test('findEntry 忽略分隔符与大小写', () => {
    const key = 'd'.repeat(64)
    const devices = [{ k: key, exp: null }]
    const spaced = key.slice(0, 32) + '-' + key.slice(32)
    t.ok(findEntry(devices, spaced.toUpperCase()), '应能匹配带横线的大写形式')
    t.eq(findEntry(devices, 'e'.repeat(64)), null)
  })
  t.test('normalizeCode 只留字母数字', () => {
    t.eq(normalizeCode(' ab12-cd34 ef56_7890 '), 'AB12CD34EF567890')
  })
})

// ------------------------------------------------------------------ 4. QQ 绑定

t.suite('QQ 绑定', () => {
  t.test('只保留数字 + 合法性', () => {
    t.eq(normalizeQQ(' 123-456 78'), '12345678')
    t.eq(isValidQQ('12345678'), true)
    t.eq(isValidQQ('1234'), false, '太短')
    t.eq(isValidQQ('0123456789'), false, '0 开头（不是合法 QQ）')
    t.eq(isValidQQ('1234567890123'), false, '太长')
  })
  t.test('掩码不泄露完整号', () => {
    t.eq(maskQQ('123456789'), '123***89')
    t.ok(!maskQQ('123456789').includes('4567'), '掩码里不该出现中间 4 位')
    t.eq(maskQQ('12345'), '1***45')
  })
  t.test('白名单条目带 qq 掩码 + qk', () => {
    const entryKey = 'a'.repeat(64)
    const qk = 'b'.repeat(64)
    const parsed = parseWhitelist(JSON.stringify({
      updatedAt: '2026-11-27T00:00:00.000Z',
      devices: [{ k: entryKey, exp: null, qq: '123***89', qk }],
    }))
    t.eq(parsed.devices[0].qq, '123***89')
    t.eq(parsed.devices[0].qk, qk)
  })
  t.test('黑名单支持按 QQ 封禁（qkeys）', () => {
    const qk = 'c'.repeat(64)
    const parsed = parseBlacklist(JSON.stringify({ keys: [], qkeys: [qk] }))
    t.eq(parsed.qkeys, [qk])
    t.eq(parseBlacklist(JSON.stringify({ keys: [] })).qkeys, [], '老文件没有 qkeys 也要能读')
  })
  t.test('令牌带 QQ 时能往返', () => {
    const token = makeToken({ qqMask: '123***89', qqKey: 'd'.repeat(64) })
    t.eq(decodeToken(encodeToken(token)).qqMask, '123***89')
    t.eq(decodeToken(encodeToken(token)).qqKey, 'd'.repeat(64))
  })
  t.test('QQ 被封禁 → 换设备也是 banned', () => {
    t.eq(statusOf({ qqBanned: true }), 'banned')
    t.eq(statusOf({ qqBanned: true, hasToken: true, token: makeToken() }), 'banned')
  })
})

// ------------------------------------------------------------------ 4. 令牌

const TOKEN_KEY = 'f'.repeat(64)

const makeToken = (over = {}) => ({
  v: 1,
  k: TOKEN_KEY,
  exp: null,
  code: 'ED1D7DC1F2525FBA',
  bound: '2026-11-27T00:00:00.000Z',
  via: 'whitelist',
  ...over,
})

t.suite('本机令牌', () => {
  t.test('往返编解码', () => {
    const token = makeToken({ exp: '2027-01-01T23:59:59.000Z', via: 'migration' })
    t.eq(decodeToken(encodeToken(token)), token)
  })
  t.test('坏令牌一律拒绝', () => {
    t.eq(decodeToken('not json'), null)
    t.eq(decodeToken(JSON.stringify(makeToken({ v: 2 }))), null)
    t.eq(decodeToken(JSON.stringify(makeToken({ k: 'short' }))), null)
    t.eq(decodeToken(JSON.stringify(makeToken({ code: 'x' }))), null)
  })
  t.test('未知 via 收敛为 whitelist', () => {
    t.eq(decodeToken(JSON.stringify(makeToken({ via: 'hacked' }))).via, 'whitelist')
  })
})

// ------------------------------------------------------------------ 5. 离线授权串

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 })
const jwkPub = publicKey.export({ format: 'jwk' })
const hexOf = value => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex')
const appPublicKey = { n: hexOf(jwkPub.n), e: hexOf(jwkPub.e) }
const nodeSign = message => crypto.sign('sha256', Buffer.from(message, 'utf8'), privateKey).toString('hex')

t.suite('离线授权串', () => {
  t.test('管理端签 → 客户端验（同一份 payload）', () => {
    const device = 'ED1D-7DC1-F252-5FBA'
    const payload = buildOfflineAuthPayload(device, '20270305')
    t.eq(payload, 'YIEYU-AUTH|v4|dev=ED1D7DC1F2525FBA|exp=20270305', 'payload 变了')
    const signature = nodeSign(payload)
    t.ok(rsaVerify(appPublicKey, payload, signature), '客户端应当验签通过')

    const packed = packOfflineAuth('20270305', signature)
    const unpacked = unpackOfflineAuth(packed)
    t.ok(unpacked, '应当能解包')
    t.eq(unpacked.expToken, '20270305')
    t.ok(rsaVerify(appPublicKey, buildOfflineAuthPayload(device, unpacked.expToken), unpacked.signatureHex))
  })
  t.test('换一台设备必须验不过', () => {
    const signature = nodeSign(buildOfflineAuthPayload('ED1D-7DC1-F252-5FBA', '20270305'))
    t.ok(!rsaVerify(appPublicKey, buildOfflineAuthPayload('AAAA-BBBB-CCCC-DDDD', '20270305'), signature), '跨设备不应验过')
  })
  t.test('篡改签名必须验不过', () => {
    const signature = nodeSign(buildOfflineAuthPayload('ED1D-7DC1-F252-5FBA', '20270305'))
    const broken = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1)
    t.ok(!rsaVerify(appPublicKey, buildOfflineAuthPayload('ED1D-7DC1-F252-5FBA', '20270305'), broken))
  })
  t.test('格式检查', () => {
    t.eq(unpackOfflineAuth('YEYA.2027.abc'), null, '签名长度不够应拒绝')
    t.eq(unpackOfflineAuth('YMG1-ABC'), null, '迁移码不是离线授权串')
    t.eq(unpackOfflineAuth('YEYA.20270305.' + 'a'.repeat(511)), null, '签名不是偶数长度')
  })
})

// ------------------------------------------------------------------ 6. 状态机

const NOW = Date.parse('2026-11-27T00:00:00.000Z')
const FUTURE = '2027-11-27T00:00:00.000Z'
const PAST = '2025-01-01T00:00:00.000Z'

const baseInput = (over = {}) => ({
  nativeOk: true,
  biometricOk: true,
  biometricMessage: '',
  hasToken: false,
  token: null,
  entry: null,
  cloudFresh: false,
  banned: false,
  clockSkew: false,
  ...over,
})

const statusOf = input => evaluate(baseInput(input), NOW).status

t.suite('状态机', () => {
  t.test('授权核挂了 → error', () => {
    t.eq(statusOf({ nativeOk: false }), 'error')
  })
  t.test('封禁优先于一切', () => {
    t.eq(statusOf({ banned: true, hasToken: true }), 'banned')
  })
  t.test('时钟回拨 → tampered', () => {
    t.eq(statusOf({ clockSkew: true }), 'tampered')
  })
  t.test('没指纹 → no_biometric（哪怕白名单里已授权）', () => {
    t.eq(statusOf({ biometricOk: false, cloudFresh: true, entry: { k: TOKEN_KEY, exp: null } }), 'no_biometric')
  })
  t.test('白名单有本机、没令牌 → ready', () => {
    t.eq(statusOf({ cloudFresh: true, entry: { k: TOKEN_KEY, exp: FUTURE } }), 'ready')
  })
  t.test('白名单没有、没令牌 → none', () => {
    t.eq(statusOf({ cloudFresh: true, entry: null }), 'none')
  })
  t.test('有令牌但还没验指纹 → locked', () => {
    t.eq(statusOf({ hasToken: true, token: null }), 'locked')
  })
  t.test('有令牌且已解锁 → active', () => {
    t.eq(statusOf({ hasToken: true, token: makeToken() }), 'active')
  })
  t.test('云端把本机删了 → 令牌作废（只在新鲜拉取时）', () => {
    t.eq(statusOf({ hasToken: true, token: makeToken(), cloudFresh: true, entry: null }), 'none')
    t.eq(statusOf({ hasToken: true, token: makeToken(), cloudFresh: false, entry: null }), 'active')
  })
  t.test('迁移码/离线串令牌不被云端名单否决（只受黑名单约束）', () => {
    const token = makeToken({ via: 'migration' })
    t.eq(statusOf({ hasToken: true, token, cloudFresh: true, entry: null }), 'active')
    t.eq(statusOf({ hasToken: true, token, cloudFresh: true, entry: null, banned: true }), 'banned')
  })
  t.test('到期 → expired（云端与本地取其一）', () => {
    t.eq(statusOf({ hasToken: true, token: makeToken({ exp: PAST }) }), 'expired')
    t.eq(statusOf({ hasToken: true, token: makeToken(), cloudFresh: true, entry: { k: TOKEN_KEY, exp: PAST } }), 'expired')
    t.eq(statusOf({ cloudFresh: true, entry: { k: TOKEN_KEY, exp: PAST } }), 'expired')
  })
  t.test('续期/改期 → ready（要求重新验指纹同步）', () => {
    t.eq(statusOf({
      hasToken: true,
      token: makeToken({ exp: FUTURE }),
      cloudFresh: true,
      entry: { k: TOKEN_KEY, exp: '2028-01-01T00:00:00.000Z' },
    }), 'ready')
  })
  t.test('永久授权的文案', () => {
    const result = evaluate(baseInput({ hasToken: true, token: makeToken() }), NOW)
    t.eq(result.status, 'active')
    t.eq(result.daysLeft, null)
    t.eq(result.message, '已授权，永久有效')
  })
  t.test('剩余天数按天向上取整', () => {
    const result = evaluate(baseInput({ hasToken: true, token: makeToken({ exp: FUTURE }) }), NOW)
    t.eq(result.daysLeft, 365)
  })
  t.test('每个状态都有中文文案', () => {
    for (const status of ['boot', 'none', 'ready', 'locked', 'active', 'expired', 'banned', 'tampered', 'no_biometric', 'error']) {
      const text = statusText(status)
      t.ok(typeof text === 'string' && text.length > 0, '缺少文案: ' + status)
    }
  })
  t.test('isExpired 对永久/非法时间都返回 false', () => {
    t.eq(isExpired(null, NOW), false)
    t.eq(isExpired('not-a-date', NOW), false)
    t.eq(isExpired(PAST, NOW), true)
  })
})

// ------------------------------------------------------------------ 跑

let failed = 0
for (const suite of suites) {
  current = { tests: [] }
  try {
    suite.fn()
  } catch (error) {
    console.error(`✗ ${suite.name}: 用例注册失败: ${error.message}`)
    failed++
    continue
  }
  for (const test of current.tests) {
    try {
      await test.fn()
      console.log(`  ✓ ${suite.name} · ${test.name}`)
    } catch (error) {
      failed++
      console.error(`  ✗ ${suite.name} · ${test.name}\n      ${error.message}`)
    }
  }
}

console.log(failed === 0 ? '\n授权协议回归全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
