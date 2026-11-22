import presets from '@/config/soundEffectPresets.json'

export const frequencies = presets.frequencies
export const equalizerPresets = presets.equalizer
export const convolutionPresets = presets.convolution

/**
 * Aurora-27：31 段（三分之一倍频程）中心频率，20Hz~20kHz。
 * 与 android/sound-effects/src/main/cpp/eq31.h 的 kThirdOctaveFreq 逐项一致，改一处必须改两处。
 */
export const frequencies31 = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160,
  200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
  20000,
]

export type BandKey = Extract<keyof LX.AppSetting, `player.soundEffect.biquadFilter.hz${number}`>
export type BandKey31 = Extract<keyof LX.AppSetting, `player.soundEffect.biquadFilter31.hz${number}`>

export interface SoundEffectConfig {
  equalizer: boolean
  /** 均衡段数：10（老十段）/ 31（三分之一倍频程） */
  eqMode: number
  gains: number[]
  gains31: number[]
  /** 自动预衰减（防叠加增益把限幅器压爆） */
  eqHeadroom: boolean
  source: string
  dry: number
  wet: number
  /** 0 关 / 1 宽阔 / 2 沉浸 / 3 旋转 / 4 蝰蛇 */
  surroundMode: number
  /** 0..1 */
  surroundStrength: number
  /** 旋转速度 Hz */
  surroundSpeed: number
  /** 头追双耳渲染（Steam Audio HRTF） */
  headTrack: boolean
  /** Aurora-29：模拟黑胶 / 胆机总开关 */
  vinylEnable: boolean
  /** 味精加量 0..1 */
  vinylAmount: number
  /** 胆机软削波 */
  vinylTube: boolean
  /** 黑胶底噪 */
  vinylNoise: boolean
  /** Wow & Flutter */
  vinylWow: boolean
  /** true = 4 倍过采样，false = 2 倍（省电） */
  vinylHiFi: boolean
  /** 16kHz 陡峭低通（蓝牙防高频毛刺），默认开 */
  vinylLpf: boolean
}

const finite = (value: unknown, fallback: number, min: number, max: number) => {
  return typeof value == 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export const bandKey = (frequency: number) => ('player.soundEffect.biquadFilter.hz' + frequency) as BandKey
export const bandKey31 = (frequency: number) => ('player.soundEffect.biquadFilter31.hz' + frequency) as BandKey31

/** 均衡段数：只有明确存成 10 的才当十段，其它（含老版本没有这个键）一律按 31 段 */
export const eqModeOf = (setting: Partial<LX.AppSetting>) =>
  Number(setting['player.soundEffect.equalizer.mode']) === 10 ? 10 : 31

/** 老版本存过 5（蝰蛇）/6（旋转），迁移到新档位 */
const normalizeSurroundMode = (value: unknown) => {
  const mode = Math.round(finite(value, 0, 0, 6))
  if (mode === 5) return 4
  if (mode === 6) return 3
  return Math.round(finite(mode, 0, 0, 4))
}
export const normalizeSoundEffect = (setting: Partial<LX.AppSetting>): SoundEffectConfig => ({
  equalizer: setting['player.soundEffect.equalizer.enable'] === true,
  eqMode: eqModeOf(setting),
  gains: frequencies.map(f => finite(setting[bandKey(f)], 0, -15, 15)),
  gains31: frequencies31.map(f => finite(setting[bandKey31(f)], 0, -15, 15)),
  eqHeadroom: setting['player.soundEffect.equalizer.headroom'] !== false,
  source: convolutionPresets.some(p => p.source === setting['player.soundEffect.convolution.fileName']) ? setting['player.soundEffect.convolution.fileName']! : '',
  dry: finite(setting['player.soundEffect.convolution.mainGain'], 10, 0, 50) / 10,
  wet: finite(setting['player.soundEffect.convolution.sendGain'], 10, 0, 50) / 10,
  surroundMode: normalizeSurroundMode(setting['player.soundEffect.surround.mode']),
  surroundStrength: finite(setting['player.soundEffect.surround.strength'], 60, 0, 100) / 100,
  surroundSpeed: finite(setting['player.soundEffect.surround.speed'], 12, 2, 60) / 100,
  headTrack: setting['player.soundEffect.headTrack.enable'] === true,
  vinylEnable: setting['player.soundEffect.vinyl.enable'] === true,
  vinylAmount: finite(setting['player.soundEffect.vinyl.amount'], 55, 0, 100) / 100,
  vinylTube: setting['player.soundEffect.vinyl.tube'] !== false,
  vinylNoise: setting['player.soundEffect.vinyl.noise'] !== false,
  vinylWow: setting['player.soundEffect.vinyl.wow'] !== false,
  vinylHiFi: setting['player.soundEffect.vinyl.hifi'] !== false,
  vinylLpf: setting['player.soundEffect.vinyl.lpf'] !== false,
})

export const equalizerSetting = (gains: number[]): Partial<LX.AppSetting> => Object.fromEntries([
  ['player.soundEffect.equalizer.enable', true],
  ['player.soundEffect.equalizer.mode', 10],
  ...frequencies.map((f, i) => [bandKey(f), finite(gains[i], 0, -15, 15)]),
]) as Partial<LX.AppSetting>

/** 31 段：一次写 31 个增益 + 打开 EQ + 切到 31 段 */
export const equalizerSetting31 = (gains: number[]): Partial<LX.AppSetting> => Object.fromEntries([
  ['player.soundEffect.equalizer.enable', true],
  ['player.soundEffect.equalizer.mode', 31],
  ...frequencies31.map((f, i) => [bandKey31(f), finite(gains[i], 0, -15, 15)]),
]) as Partial<LX.AppSetting>

/** 只写 31 段增益（不动开关/段数）：曲线拖动时高频调用，别顺手把 EQ 打开 */
export const eqGains31Setting = (gains: number[]): Partial<LX.AppSetting> => Object.fromEntries([
  ...frequencies31.map((f, i) => [bandKey31(f), finite(gains[i], 0, -15, 15)]),
]) as Partial<LX.AppSetting>

export const eqModeSetting = (mode: number, enable = true): Partial<LX.AppSetting> => ({
  'player.soundEffect.equalizer.enable': enable,
  'player.soundEffect.equalizer.mode': mode === 10 ? 10 : 31,
})

export const eqHeadroomSetting = (enable: boolean): Partial<LX.AppSetting> => ({
  'player.soundEffect.equalizer.headroom': enable,
})

/** 整套均衡设置（预设回放用）：段数、两组增益、自动预衰减一起还原 */
export const eqConfigSetting = (config: SoundEffectConfig): Partial<LX.AppSetting> => Object.fromEntries([
  ['player.soundEffect.equalizer.enable', config.equalizer],
  ['player.soundEffect.equalizer.mode', config.eqMode === 10 ? 10 : 31],
  ['player.soundEffect.equalizer.headroom', config.eqHeadroom !== false],
  ...frequencies.map((f, i) => [bandKey(f), finite(config.gains[i], 0, -15, 15)]),
  ...frequencies31.map((f, i) => [bandKey31(f), finite(config.gains31[i], 0, -15, 15)]),
]) as Partial<LX.AppSetting>

export const surroundSetting = (mode: number, strengthPercent: number): Partial<LX.AppSetting> => ({
  'player.soundEffect.surround.mode': Math.max(0, Math.min(4, Math.round(mode))),
  'player.soundEffect.surround.strength': Math.max(0, Math.min(100, Math.round(strengthPercent))),
})

/** Aurora-29：味精加量（0..100 整数百分比），同时打开总开关 */
export const vinylSetting = (percent: number): Partial<LX.AppSetting> => ({
  'player.soundEffect.vinyl.enable': true,
  'player.soundEffect.vinyl.amount': Math.max(0, Math.min(100, Math.round(percent))),
})

/** 只写加量（拖动滑块时高频调用，别顺手把开关打开） */
export const vinylAmountSetting = (percent: number): Partial<LX.AppSetting> => ({
  'player.soundEffect.vinyl.amount': Math.max(0, Math.min(100, Math.round(percent))),
})

const VINYL_KEY = {
  tube: 'player.soundEffect.vinyl.tube',
  noise: 'player.soundEffect.vinyl.noise',
  wow: 'player.soundEffect.vinyl.wow',
  hifi: 'player.soundEffect.vinyl.hifi',
  lpf: 'player.soundEffect.vinyl.lpf',
} as const

/** 子开关：胆机 / 底噪 / 肉摇 / 高保真 4 倍过采样 */
export const vinylToggleSetting = (name: keyof typeof VINYL_KEY, on: boolean): Partial<LX.AppSetting> =>
  ({ [VINYL_KEY[name]]: on }) as Partial<LX.AppSetting>

/** 三档预设：淡 / 香 / 醉（同时把三个子模块都打开） */
export const vinylPresetSetting = (percent: number): Partial<LX.AppSetting> => ({
  'player.soundEffect.vinyl.enable': true,
  'player.soundEffect.vinyl.amount': Math.max(0, Math.min(100, Math.round(percent))),
  'player.soundEffect.vinyl.tube': true,
  'player.soundEffect.vinyl.noise': true,
  'player.soundEffect.vinyl.wow': true,
  'player.soundEffect.vinyl.lpf': true,
})

/** 速度用厘赫存（2..60 对应 0.02..0.60 Hz），滑块只处理整数 */
export const surroundSpeedSetting = (centiHz: number): Partial<LX.AppSetting> => ({
  'player.soundEffect.surround.speed': Math.max(2, Math.min(60, Math.round(centiHz))),
})

export const convolutionSetting = (source: string, dry: number, wet: number): Partial<LX.AppSetting> => ({
  'player.soundEffect.convolution.fileName': source,
  'player.soundEffect.convolution.mainGain': Math.round(dry * 100) / 10,
  'player.soundEffect.convolution.sendGain': Math.round(wet * 100) / 10,
})

export interface UserSoundEffectPreset {
  id: string
  name: string
  type: 'equalizer' | 'convolution'
  config: SoundEffectConfig
}

export const parseUserPresets = (text: string): UserSoundEffectPreset[] => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    const ids = new Set<string>()
    const counts = { equalizer: 0, convolution: 0 }
    const list = parsed.filter((item): item is UserSoundEffectPreset => {
      if (!item || typeof item != 'object' || typeof item.id != 'string' || ids.has(item.id as string) ||
        typeof item.name != 'string' || !item.name.trim() || item.name.length > 32 ||
        (item.type != 'equalizer' && item.type != 'convolution') || !item.config ||
        !Array.isArray(item.config.gains) || item.config.gains.length !== frequencies.length ||
        item.config.gains.some((gain: unknown) => typeof gain != 'number' || !Number.isFinite(gain) || Math.abs(gain) > 15) ||
        (item.config.gains31 != null && (!Array.isArray(item.config.gains31) || item.config.gains31.length !== frequencies31.length ||
          item.config.gains31.some((gain: unknown) => typeof gain != 'number' || !Number.isFinite(gain) || Math.abs(gain) > 15))) ||
        typeof item.config.equalizer != 'boolean' ||
        typeof item.config.dry != 'number' || !Number.isFinite(item.config.dry) || item.config.dry < 0 || item.config.dry > 5 ||
        typeof item.config.wet != 'number' || !Number.isFinite(item.config.wet) || item.config.wet < 0 || item.config.wet > 5 ||
        typeof item.config.source != 'string' ||
        (item.config.source && !convolutionPresets.some(p => p.source == item.config.source))) return false
      const type = item.type as UserSoundEffectPreset['type']
      if (counts[type] >= 31) return false
      counts[type]++
      ids.add(item.id as string)
      return true
    })
    // 老预设没有 31 段数据：补成全平，别让界面拿到 undefined
    return list.map(item => ({
      ...item,
      config: {
        ...item.config,
        eqMode: Number(item.config.eqMode) === 10 ? 10 : 31,
        gains31: Array.isArray(item.config.gains31) && item.config.gains31.length == frequencies31.length
          ? item.config.gains31
          : frequencies31.map(() => 0),
        eqHeadroom: item.config.eqHeadroom !== false,
      },
    }))
  } catch { return [] }
}
