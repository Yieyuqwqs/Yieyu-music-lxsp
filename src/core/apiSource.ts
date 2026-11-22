/**
 * 音源装配入口（原 apiSource.ts 的职责被收窄成「把设置喂给引擎」）。
 *
 * 旧实现：按 common.apiSource 决定加载哪个 api 实现 or 哪个 JS 脚本，
 *        并且每个实现都会改写 global.lx.qualityList —— 各自为战。
 * 新实现：只有一个引擎，端点来自设置，能力来自 manifest；
 *        global.lx.qualityList 只是引擎质量的投影，谁也不再直接写它。
 */
import settingState from '@/store/setting/state'
import { log as writeLog } from '@/utils/log'
import { updateSetting } from './common'
import { rememberSource } from './sourceMemory'
import {
  sourceEngine,
  parseEndpoints,
  parseCustomSources,
  type EngineInitResult,
  type EndpointStatus,
} from './source'

const ONLINE_SOURCES: readonly LX.Source[] = ['kw', 'kg', 'tx', 'wy', 'mg']

export interface SourceEngineStatus {
  inited: boolean
  providerCount: number
  sources: LX.Source[]
  qualityList: LX.QualityList
  endpoints: EndpointStatus[]
  manifests: number
}

const createInitPromise = () => {
  global.lx.apiInitPromise[0] = new Promise<boolean>((resolve) => {
    global.lx.apiInitPromise[1] = false
    global.lx.apiInitPromise[2] = (success: boolean) => {
      global.lx.apiInitPromise[1] = true
      resolve(success)
    }
  })
}

const settleInitPromise = (success: boolean) => {
  if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](success)
}

/** 读取设置 → 重建引擎 → 投影 qualityList */
export const initSourceEngine = async(): Promise<EngineInitResult> => {
  const setting = settingState.setting
  const endpoints = parseEndpoints(setting['common.lxspEndpoints'], setting['common.lxspToken'])

  let customSources: ReturnType<typeof parseCustomSources> = []
  try {
    customSources = parseCustomSources(setting['common.customSources'])
  } catch (error) {
    writeLog.warn(`自定义源配置无效：${(error as Error).message}`)
  }

  const result = await sourceEngine.init({
    endpoints,
    token: setting['common.lxspToken'] || null,
    customSources,
    rememberSource: ({ source, name, singer }) => {
      if (!name) return
      rememberSource({ name, singer, source })
    },
    onLog: (level, message) => {
      if (level === 'error') writeLog.error(message)
      else if (level === 'warn') writeLog.warn(message)
      else writeLog.info(message)
    },
  })

  global.lx.qualityList = result.qualityList

  // 一个能出直链的音源都没有：视为音源初始化失败（避免界面显示可用、点了却放不出来）
  const playable = ONLINE_SOURCES.filter(source => sourceEngine.hasUrlProvider(source))
  if (!playable.length) {
    writeLog.warn(`no playable source: ${JSON.stringify(result.endpoints)}`)
  }
  return { ...result, ok: playable.length > 0 }
}

/**
 * 兼容旧调用点：参数 apiId 现在只用于记录用户上次的选择，
 * 不再决定加载哪套实现（所有音源统一走 LXSP 引擎）。
 */
export const setApiSource = (apiId: string) => {
  if (global.lx.apiInitPromise[1]) createInitPromise()

  void initSourceEngine().then((result) => {
    settleInitPromise(result.ok)
    requestAnimationFrame(() => {
      global.state_event.apiSourceUpdated(apiId)
    })
    if (apiId != settingState.setting['common.apiSource']) {
      // 保持设置项语义：记录当前生效的音源标识（'lxsp' 或历史脚本 id）
      updateSetting({ 'common.apiSource': apiId })
    }
  }).catch((error: unknown) => {
    settleInitPromise(false)
    writeLog.error(`source engine init failed: ${(error as Error)?.message ?? String(error)}`)
  })
}

/** 设置页自检用 */
export const getEngineStatus = (): SourceEngineStatus => {
  const qualityList = sourceEngine.qualityList()
  return {
    inited: sourceEngine.isInited,
    providerCount: sourceEngine.registryInstance.size,
    sources: Object.keys(qualityList) as LX.Source[],
    qualityList,
    endpoints: sourceEngine.endpointStatus,
    manifests: sourceEngine.endpointStatus.filter(item => item.ok).length,
  }
}

/** 探测端点健康（设置页「测试连接」） */
export const probeEndpoints = (): Promise<EndpointStatus[]> => sourceEngine.probe()
