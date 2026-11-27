import AsyncStorage from '@react-native-async-storage/async-storage'
import { log } from '@/utils/log'
import { post as corePost, request as coreRequest, isCoreSupported } from '@/core-bridge'
import { BoundedKvCache } from './kv-cache'

const partKeyPrefix = '@___PART___'
const partKeyArrPrefix = '@___PART_A___'
const partKeyPrefixRxp = /^@___PART___/
const partKeyArrPrefixRxp = /^@___PART_A___/
const keySplit = ','
const limit = 500000

/**
 * M3-3：存储读路径切到 C++（SQLite 为真源）。
 *   1) 进程内缓存（同一 key 只解析一次）
 *   2) C++ SQLite（kv.get）
 *   3) AsyncStorage 兜底（迁移期；命中后回写缓存与 C++，实现懒迁移）
 * 全程异步、不阻塞 UI；核心不可用时行为与旧版完全一致。
 */
// 有界缓存：以前是裸 Map（无上限无淘汰），歌单一多就常驻几十 MB
const kvCache = new BoundedKvCache({ maxEntries: 128, maxBytes: 24 * 1024 * 1024 })

/** 镜像上限：超过这个体积只留在 AsyncStorage（C++ kv 不适合塞巨型 blob） */
const MIRROR_LIMIT = 8 * 1024 * 1024

/**
 * 唯一的「写穿透」出口：内存缓存 + C++ 真源必须同时更新。
 * 之前 saveData / saveDataMultiple 各写各的，批量路径既没缓存也没镜像，
 * 结果批量存完的列表读回来是上一次的旧值。
 */
const cacheStore = (key: string, valueStr: string) => {
  if (valueStr.length > MIRROR_LIMIT) return
  kvCache.set(key, valueStr)
  try {
    corePost('kv.set', { k: key, v: valueStr })
  } catch { /* 镜像失败绝不影响主存储 */ }
}

/** 唯一的「删穿透」出口：三层一起删，否则删完还能从缓存里读到（解封会失效） */
const cacheDrop = (key: string) => {
  kvCache.delete(key)
  try {
    corePost('kv.remove', { k: key })
  } catch { /* 镜像失败绝不影响主存储 */ }
}

/** 命中 AsyncStorage 旧数据时回填：内存缓存 + C++ 真源（懒迁移，不阻塞） */
const backfill = (key: string, value: string) => {
  cacheStore(key, value)
}

/** 只负责分片；序列化在上层做一次（大列表 getData 时少一次 JSON.stringify） */
const buildData = (key: string, valueStr: string, datas: Array<[string, string]>) => {
  if (valueStr.length <= limit) {
    datas.push([key, valueStr])
    return
  }

  const partKeys = []
  for (let i = 0, len = Math.floor(valueStr.length / limit); i <= len; i++) {
    let partKey = `${partKeyArrPrefix}${key}${i}`
    partKeys.push(partKey)
    datas.push([partKey, valueStr.substring(i * limit, (i + 1) * limit)])
  }
  datas.push([key, partKeyArrPrefix + JSON.stringify(partKeys)])
}

// 1.4.0 之前的数据分片存储方式，存在key的内容与分隔符冲突的问题
// 1.4.0 开始改用数组存储，不再使用分隔符的方式
const handleGetDataOld = async<T>(partKeys: string): Promise<T> => {
  const keys = partKeys.replace(partKeyPrefixRxp, '').split(keySplit)

  return AsyncStorage.multiGet(keys).then(datas => {
    return JSON.parse(datas.map(data => data[1]).join(''))
  })
}

const handleGetData = async<T>(partKeys: string): Promise<T> => {
  if (partKeys.startsWith(partKeyPrefix)) return handleGetDataOld<T>(partKeys)

  const keys = JSON.parse(partKeys.replace(partKeyArrPrefixRxp, '')) as string[]
  return AsyncStorage.multiGet(keys).then(datas => {
    return JSON.parse(datas.map(data => data[1]).join(''))
  })
}

export const saveData = async(key: string, value: any) => {
  const datas: Array<[string, string]> = []
  // 只序列化一次：分片和镜像都用这同一个字符串
  const raw = JSON.stringify(value)
  buildData(key, raw, datas)

  try {
    await removeData(key)
    await AsyncStorage.multiSet(datas)
    cacheStore(key, raw)
  } catch (e: any) {
    // saving error
    log.error('storage error[saveData]:', key, e.message)
    throw e
  }
}

export const getData = async<T = unknown>(key: string): Promise<T | null> => {
  const cached = kvCache.get(key)
  if (cached != null) {
    try {
      return JSON.parse(cached) as T
    } catch { /* 缓存脏了就继续走真源 */ }
  }
  if (isCoreSupported) {
    const hit = await coreRequest<{ found?: boolean, v?: string, omitted?: boolean }>('kv.get', { k: key })
    if (hit && hit.found && !hit.omitted && typeof hit.v == 'string') {
      kvCache.set(key, hit.v)
      try {
        return JSON.parse(hit.v) as T
      } catch { /* 解析失败退旧路径 */ }
    }
  }
  let value: string | null
  try {
    value = await AsyncStorage.getItem(key)
  } catch (e: any) {
    // error reading value
    log.error('storage error[getData]:', key, e.message)
    throw e
  }
  if (value && (partKeyPrefixRxp.test(value) || partKeyArrPrefixRxp.test(value))) {
    const parsed = await handleGetData<T>(value)
    backfill(key, JSON.stringify(parsed))
    return parsed
  } else if (value == null) return value
  backfill(key, value)
  return JSON.parse(value)
}

export const removeData = async(key: string) => {
  // 先删内存缓存 + C++：读路径优先命中这两层，晚一步就会把删掉的值再读回来
  cacheDrop(key)
  let value: string | null
  try {
    value = await AsyncStorage.getItem(key)
  } catch (e: any) {
    // error reading value
    log.error('storage error[removeData]:', key, e.message)
    throw e
  }
  if (value) {
    if (partKeyPrefixRxp.test(value)) {
      let partKeys = value.replace(partKeyPrefixRxp, '').split(keySplit)
      partKeys.push(key)
      try {
        await AsyncStorage.multiRemove(partKeys)
      } catch (e: any) {
        // remove error
        log.error('storage error[removeData]:', key, e.message)
        throw e
      }
      return
    } else if (partKeyArrPrefixRxp.test(value)) {
      let partKeys = JSON.parse(value.replace(partKeyArrPrefixRxp, '')) as string[]
      partKeys.push(key)
      try {
        await AsyncStorage.multiRemove(partKeys)
      } catch (e: any) {
        // remove error
        log.error('storage error[removeData]:', key, e.message)
        throw e
      }
      return
    }
  }

  try {
    await AsyncStorage.removeItem(key)
  } catch (e: any) {
    // remove error
    log.error('storage error[removeData]:', key, e.message)
    throw e
  }
}

export const getAllKeys = async() => {
  let keys
  try {
    keys = await AsyncStorage.getAllKeys()
  } catch (e: any) {
    // read key error
    log.error('storage error[getAllKeys]:', e.message)
    throw e
  }

  return keys
}


export const getDataMultiple = async<T extends readonly string[]>(keys: T) => {
  type RawData = { [K in keyof T]: [T[K], string | null] }
  let datas: RawData
  try {
    datas = await AsyncStorage.multiGet(keys) as RawData
  } catch (e: any) {
    // read error
    log.error('storage error[getDataMultiple]:', e.message)
    throw e
  }
  const promises: Array<Promise<ReadonlyArray<[unknown | null]>>> = []
  for (const [, value] of datas) {
    if (value && (partKeyPrefixRxp.test(value) || partKeyArrPrefixRxp.test(value))) {
      promises.push(handleGetData(value))
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      promises.push(Promise.resolve(value ? JSON.parse(value) : value))
    }
  }
  return Promise.all(promises).then(values => {
    return datas.map(([key], index) => ([key, values[index]])) as { [K in keyof T]: [T[K], unknown] }
  })
}

export const saveDataMultiple = async(datas: Array<[string, any]>) => {
  const allData: Array<[string, string]> = []
  const mirrors: Array<[string, string]> = []
  for (const [key, value] of datas) {
    const raw = JSON.stringify(value)
    buildData(key, raw, allData)
    mirrors.push([key, raw])
  }
  try {
    await removeDataMultiple(datas.map(k => k[0]))
    await AsyncStorage.multiSet(allData)
    // 批量路径同样是写穿透：不镜像的话，下一次 getData 会命中旧缓存
    for (const [key, raw] of mirrors) cacheStore(key, raw)
  } catch (e: any) {
    // save error
    log.error('storage error[saveDataMultiple]:', e.message)
    throw e
  }
}


export const removeDataMultiple = async(keys: string[]) => {
  if (!keys.length) return
  for (const key of keys) cacheDrop(key)
  const datas = await AsyncStorage.multiGet(keys)
  let allKeys = []
  for (const [key, value] of datas) {
    allKeys.push(key)
    if (value) {
      if (partKeyPrefixRxp.test(value)) {
        allKeys.push(...value.replace(partKeyPrefixRxp, '').split(keySplit))
      } else if (partKeyArrPrefixRxp.test(value)) {
        allKeys.push(...JSON.parse(value.replace(partKeyArrPrefixRxp, '')) as string[])
      }
    }
  }
  try {
    await AsyncStorage.multiRemove(allKeys)
  } catch (e: any) {
    // remove error
    log.error('storage error[removeDataMultiple]:', e.message)
    throw e
  }
}

export const clearAll = async() => {
  try {
    kvCache.clear()
    await AsyncStorage.clear()
  } catch (e: any) {
    // clear error
    log.error('storage error[clearAll]:', e.message)
    throw e
  }
}

export { useAsyncStorage } from '@react-native-async-storage/async-storage'
