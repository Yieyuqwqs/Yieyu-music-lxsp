/**
 * 小密钥存取：能加密落盘就落盘，不能就只放内存 —— 绝不明文落盘
 *
 * 背景：管理端的 GitHub PAT 以前明文存在 AsyncStorage；现在走 Android Keystore。
 * 这里用内存假桥模拟原生模块，验证两条路径与失败降级都成立。
 */
import { NativeModules } from 'react-native'
import {
  __clearSecretMemory,
  getSecret,
  isSecureStoreAvailable,
  removeSecret,
  setSecret,
} from '../../src/utils/nativeModules/secureStore.ts'

const installFakeBridge = (options = {}) => {
  const store = new Map()
  NativeModules.YieyuAuth = {
    secretSet: async(name, value) => {
      if (options.failSet) throw new Error('keystore boom')
      store.set(name, value)
      return null
    },
    secretGet: async(name) => (options.failGet ? null : (store.get(name) ?? null)),
    secretRemove: async(name) => { store.delete(name); return null },
  }
  return store
}

const removeFakeBridge = () => { delete NativeModules.YieyuAuth }

export default (t) => {
  t.suite('小密钥：原生桥可用时加密落盘（persisted=true）', async() => {
    __clearSecretMemory()
    const store = installFakeBridge()
    try {
      t.ok(isSecureStoreAvailable(), '注入假桥后必须判定为可用')
      const result = await setSecret('admin.token', 'ghp_demo_token')
      t.eq(result.persisted, true, '必须报告已落盘')
      t.eq(store.get('admin.token'), 'ghp_demo_token', '密文存储层要收到原值（加密由原生负责）')
      __clearSecretMemory()
      t.eq(await getSecret('admin.token'), 'ghp_demo_token', '清掉内存缓存后必须能从原生窑里读回')
    } finally { removeFakeBridge() }
  })

  t.suite('小密钥：原生桥缺失时只放内存，并且明确告知（persisted=false）', async() => {
    __clearSecretMemory()
    removeFakeBridge()
    try {
      t.ok(!isSecureStoreAvailable(), '没有原生桥必须判定为不可用')
      const result = await setSecret('admin.token', 'ghp_demo_token')
      t.eq(result.persisted, false, '不许谎报已落盘')
      t.ok(!!result.reason && result.reason.includes('内存'), `原因必须说明只保留在内存，实际：${result.reason}`)
      t.eq(await getSecret('admin.token'), 'ghp_demo_token', '内存里仍然可用（当次运行内）')
      __clearSecretMemory()
      t.eq(await getSecret('admin.token'), null, '内存清空后读不到（说明确实没落盘）')
    } finally { removeFakeBridge() }
  })

  t.suite('小密钥：写入失败（Keystore 异常）也必须降级而不是丢异常', async() => {
    __clearSecretMemory()
    installFakeBridge({ failSet: true })
    try {
      const result = await setSecret('admin.token', 'ghp_demo_token')
      t.eq(result.persisted, false, '写入失败必须报告未落盘')
      t.ok(!!result.reason && result.reason.includes('硬件密钥'), `原因要指出是硬件密钥问题，实际：${result.reason}`)
      t.eq(await getSecret('admin.token'), 'ghp_demo_token', '内存里仍要可用')
      await removeSecret('admin.token')
      t.eq(await getSecret('admin.token'), null, '删除后读不到')
    } finally { removeFakeBridge() }
  })
}
