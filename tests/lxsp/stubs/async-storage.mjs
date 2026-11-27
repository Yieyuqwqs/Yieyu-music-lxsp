// node 侧的 AsyncStorage 桩（测试专用）：纯内存，语义与真实实现一致
const store = new Map()

export const __asStore = store
export const __resetAsyncStorage = () => { store.clear() }

const getItem = async(key) => (store.has(key) ? store.get(key) : null)
const setItem = async(key, value) => { store.set(key, String(value)) }
const removeItem = async(key) => { store.delete(key) }
const multiGet = async(keys) => keys.map(key => [key, store.has(key) ? store.get(key) : null])
const multiSet = async(pairs) => { for (const [key, value] of pairs) store.set(key, String(value)) }
const multiRemove = async(keys) => { for (const key of keys) store.delete(key) }
const getAllKeys = async() => [...store.keys()]
const clear = async() => { store.clear() }
const mergeItem = async(key, value) => { store.set(key, String(value)) }

const AsyncStorage = { getItem, setItem, removeItem, multiGet, multiSet, multiRemove, getAllKeys, clear, mergeItem }

export const useAsyncStorage = () => ({ getItem, setItem, removeItem, mergeItem })

export default AsyncStorage
