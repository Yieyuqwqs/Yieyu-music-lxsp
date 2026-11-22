import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, ScrollView, View } from 'react-native'
import Button from '@/components/common/Button'
import CheckBox from '@/components/common/CheckBox'
import Input from '@/components/common/Input'
import Popup, { type PopupType } from '@/components/common/Popup'
import Slider from '@/components/common/Slider'
import Text from '@/components/common/Text'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import settingState from '@/store/setting/state'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { useIsPro } from '@/store/license/hook'
import { applySoundEffect, getSoundEffectStats, isSoundEffectSupported, useSoundEffectConfig, useSoundEffectStatus, type SoundEffectStats } from '@/plugins/player/soundEffect'
import {
  bandKey, convolutionPresets, convolutionSetting, eqConfigSetting, eqGains31Setting, eqHeadroomSetting, eqModeSetting,
  equalizerPresets, equalizerSetting, frequencies, frequencies31, normalizeSoundEffect,
  parseUserPresets, surroundSetting, surroundSpeedSetting, type UserSoundEffectPreset,
  vinylAmountSetting, vinylPresetSetting, vinylSetting, vinylToggleSetting,
} from '@/plugins/player/soundEffect/config'
import SoundEffectEq31 from '@/components/SoundEffectEq31'

/** 采样率文案：96/192 不留小数，44.1 这类保留一位，和系统音频面板的写法一致 */
const formatRate = (rate: number): string => {
  const value = Math.round(Number(rate) || 0)
  if (value <= 0) return '--'
  return value % 1000 == 0 ? String(value / 1000) : (value / 1000).toFixed(1)
}

const SURROUND_MODES = [
  { mode: 0, key: 'sound_effect_surround_off' },
  { mode: 1, key: 'sound_effect_surround_wide' },
  { mode: 2, key: 'sound_effect_surround_immerse' },
  { mode: 3, key: 'sound_effect_surround_rotate' },
  { mode: 4, key: 'sound_effect_surround_viper' },
] as const

// Aurora-29：味精三档预设
const VINYL_PRESETS = [
  { key: 'sound_effect_vinyl_light', amount: 25 },
  { key: 'sound_effect_vinyl_medium', amount: 55 },
  { key: 'sound_effect_vinyl_heavy', amount: 85 },
] as const

// 只有「沉浸」「旋转」带旋转成分，速度滑块才可用
const hasRotation = (mode: number) => mode == 2 || mode == 3

const Choice = ({ children, selected = false, disabled = false, onPress, onLongPress }: {
  children: React.ReactNode
  selected?: boolean
  disabled?: boolean
  onPress: () => void
  onLongPress?: () => void
}) => {
  const theme = useTheme()
  return (
    <Button accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} onLongPress={onLongPress}
      style={{ ...styles.choice, backgroundColor: selected ? theme['c-primary-alpha-400'] : theme['c-primary-alpha-100'], borderColor: selected ? theme['c-primary'] : 'transparent' }}>
      <Text size={13} color={selected ? theme['c-primary-font'] : theme['c-font-label']}>{children}</Text>
    </Button>
  )
}

const Section = ({ title, right, children }: {
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}) => {
  const theme = useTheme()
  return (
    <View style={{ ...styles.section, borderTopColor: theme['c-250'] }}>
      <View style={styles.sectionHeader}>
        <Text size={15} style={styles.sectionTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  )
}

const ValueSlider = ({ label, value, min, max, unit, disabled = false, display, onChange }: {
  label: string
  value: number
  min: number
  max: number
  unit: string
  disabled?: boolean
  display?: (value: number) => string
  onChange: (value: number) => void
}) => {
  // 拖动期间只维护本地临时值，松手才一次性回写设置（避免与设置回传打架导致跳动）
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const clamp = (raw: number) => Math.max(min, Math.min(max, Math.round(raw)))
  return (
    <View style={{ ...styles.sliderRow, opacity: disabled ? 0.4 : 1 }}>
      <Text size={13} style={styles.sliderLabel}>{label}</Text>
      <Slider accessibilityLabel={label} disabled={disabled} minimumValue={min} maximumValue={max} value={shown} step={1}
        onSlidingStart={next => { setDraft(clamp(next)) }}
        onValueChange={next => { setDraft(clamp(next)) }}
        onSlidingComplete={next => {
          const done = clamp(next)
          setDraft(null)
          if (done !== value) onChange(done)
        }} />
      <Text size={12} style={styles.sliderValue}>{display ? display(shown) : String(shown) + unit}</Text>
    </View>
  )
}

const PresetEditor = ({ type }: { type: UserSoundEffectPreset['type'] }) => {
  const t = useI18n()
  const theme = useTheme()
  const presetsText = useSettingValue('player.soundEffect.presets')
  const convolutionFile = useSettingValue('player.soundEffect.convolution.fileName')
  const [name, setName] = useState('')
  const presets = useMemo(() => parseUserPresets(presetsText), [presetsText])
  const list = presets.filter(item => item.type == type)
  const save = () => {
    const all = parseUserPresets(settingState.setting['player.soundEffect.presets'])
    const label = name.trim()
    if (!label || all.filter(p => p.type == type).length >= 31) return
    const config = normalizeSoundEffect(settingState.setting)
    if (type == 'convolution' && !config.source) return
    const preset = { id: Date.now().toString(36) + Math.random().toString(36).slice(2), name: label, type, config }
    updateSetting({ 'player.soundEffect.presets': JSON.stringify([...all, preset]) })
    setName('')
  }
  const remove = (id: string) => {
    Alert.alert(t('sound_effect_remove_preset'), '', [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('sound_effect_remove_preset'),
        style: 'destructive',
        onPress: () => {
          const all = parseUserPresets(settingState.setting['player.soundEffect.presets'])
          updateSetting({ 'player.soundEffect.presets': JSON.stringify(all.filter(p => p.id != id)) })
        },
      },
    ])
  }
  return (
    <View>
      <View style={styles.choices}>
        {list.map(preset => (
          <Choice key={preset.id} onLongPress={() => { remove(preset.id) }} onPress={() => {
            updateSetting(type == 'equalizer' ? eqConfigSetting(preset.config) : convolutionSetting(preset.config.source, preset.config.dry, preset.config.wet))
          }}>{preset.name}</Choice>
        ))}
      </View>
      {list.length > 0 && <Text size={12} color={theme['c-font-label']}>{t('sound_effect_preset_delete_hint')}</Text>}
      <View style={styles.saveRow}>
        <Input accessibilityLabel={t('sound_effect_preset_name')} placeholder={t('sound_effect_preset_name')} maxLength={32} value={name} onChangeText={setName} />
        <Choice disabled={!name.trim() || list.length >= 31 || (type == 'convolution' && !convolutionFile)} onPress={save}>{t('sound_effect_save_preset')}</Choice>
      </View>
    </View>
  )
}

/** 十段曲线导入到三十一段：在 log 频率轴上线性插值，手调过的十段曲线能原样搬过来 */
const importTenToThirtyOne = (gains10: number[]): number[] => {
  const freqs = frequencies.map(f => Math.log10(f))
  const logs = frequencies31.map(f => Math.log10(f))
  return logs.map(x => {
    if (x <= freqs[0]) return Math.round(gains10[0] * 2) / 2
    if (x >= freqs[freqs.length - 1]) return Math.round(gains10[gains10.length - 1] * 2) / 2
    let i = 0
    while (i < freqs.length - 2 && x > freqs[i + 1]) i++
    const t = (x - freqs[i]) / (freqs[i + 1] - freqs[i])
    return Math.round((gains10[i] + (gains10[i + 1] - gains10[i]) * t) * 2) / 2
  })
}

const SoundEffectPanel = () => {
  const t = useI18n()
  const isPro = useIsPro()
  const theme = useTheme()
  const config = useSoundEffectConfig()
  const status = useSoundEffectStatus()
  const hapticEnable = useSettingValue('player.hapticBass.enable')
  const hapticStrength = useSettingValue('player.hapticBass.strength')
  const [stats, setStats] = useState<SoundEffectStats | null>(null)
  useEffect(() => {
    let alive = true
    const pull = () => { void getSoundEffectStats().then(next => { if (alive) setStats(next) }) }
    pull()
    const timer = setInterval(pull, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  // 升频生效时的输出采样率：HiRes.destroy() 会短暂把 activeOutputRate 清零，
  // 这里记住最近一次真正生效的值，避免轮询刚好抓到 0 时又把 44.1kHz 顶回主位。
  const lastHiresOutputRef = useRef(0)
  useEffect(() => {
    if (!stats) return
    if (!stats.hiresEnabled) {
      lastHiresOutputRef.current = 0
      return
    }
    if (stats.hiresOutputRate > 0) lastHiresOutputRef.current = stats.hiresOutputRate
  }, [stats])
  const rateInfo = useMemo(() => {
    if (!stats) return null
    if (stats.hiresEnabled) {
      // 主值永远只显示「真正生效的输出采样率」，不是输入源的 44.1kHz
      const output = stats.hiresOutputRate > 0 ? stats.hiresOutputRate : lastHiresOutputRef.current
      // Aurora-15：降级链走过（192→96→48）时必须诚实标注，别让用户以为还在跑 192
      const effective = typeof stats.hiresEffectiveTarget == 'number' ? stats.hiresEffectiveTarget : stats.hiresTarget
      const degraded = stats.hiresDegraded === true || effective < stats.hiresTarget
      // effective == 0：升频已经彻底退出，按源采样率直通（也算降级，必须说清楚）
      const passthrough = degraded && effective <= 0
      const degradeCaption = passthrough
        ? `已降级 · 直通 · 目标 ${formatRate(stats.hiresTarget)} kHz`
        : `已降级 · 目标 ${formatRate(stats.hiresTarget)} kHz`
      if (output > 0) {
        return {
          label: `${formatRate(output)} kHz`,
          caption: degraded
            ? degradeCaption
            : (stats.hiresInputRate > 0 ? `升频输出 · 源 ${formatRate(stats.hiresInputRate)} kHz` : '升频输出'),
          active: !degraded,
        }
      }
      if (degraded) {
        return {
          label: passthrough ? '直通' : `${formatRate(effective)} kHz`,
          caption: degradeCaption,
          active: false,
        }
      }
      return {
        label: `${formatRate(stats.hiresTarget)} kHz`,
        caption: '目标 · 切歌后生效',
        active: false,
      }
    }
    return {
      label: `${formatRate(stats.rate)} kHz`,
      caption: stats.channels >= 2 ? '原生输出' : `${stats.channels} 声道`,
      active: false,
    }
  }, [stats])
  const translate = (key: string) => t(key as Parameters<typeof t>[0])
  return (
    <View onStartShouldSetResponder={() => true}>
      <Text size={12} color={theme['c-font-label']} style={styles.hint}>{t('sound_effect_pcm_hint')}</Text>
      {/* 顶部状态条：采样率单独做成胶囊主值，一眼能看出是 96/192 而不是源 44.1 */}
      <View style={styles.topMeta}>
        {rateInfo
          ? (
              <View style={[styles.rateTag, {
                backgroundColor: rateInfo.active ? 'rgba(110,231,183,0.14)' : theme['c-primary-alpha-900'],
                borderColor: rateInfo.active ? 'rgba(110,231,183,0.42)' : theme['c-border-background'],
              }]}>
                <Text size={12} style={[styles.rateValue, rateInfo.active ? { color: '#6EE7B7' } : null]}>{rateInfo.label}</Text>
                <Text size={10} style={styles.rateCaption} color={rateInfo.active ? '#6EE7B7' : theme['c-font-label']}>{rateInfo.caption}</Text>
              </View>
            )
          : null}
        <Text size={10} color={theme['c-font-label']} style={styles.stats} numberOfLines={1} ellipsizeMode="tail">
          {stats
            ? `已处理 ${stats.frames} 帧 · ${stats.channels >= 2 ? '立体声' : stats.channels + '声道'} · 模式 ${stats.mode} · 强度 ${Math.round(stats.strength * 100)}%`
            : '内核：未连接'}
        </Text>
      </View>
      {status == 'error' && (
        <View style={styles.status}>
          <Text size={13}>{t('sound_effect_failed')}</Text>
          <Choice onPress={() => { void applySoundEffect() }}>{t('sound_effect_retry')}</Choice>
        </View>
      )}

      <Section
        title={t('sound_effect_equalizer')}
        right={
          <View style={styles.sectionActions}>
            <Choice onPress={() => {
              updateSetting(config.eqMode == 31
                ? eqGains31Setting(frequencies31.map(() => 0))
                : equalizerSetting(frequencies.map(() => 0)))
            }}>{t('sound_effect_flat')}</Choice>
            <CheckBox check={config.equalizer} label={t('sound_effect_enable')} onChange={enable => { updateSetting({ 'player.soundEffect.equalizer.enable': enable }) }} />
          </View>
        }
      >
        {/* Aurora-27 三挡：直接关 / 十段 / 三十一段。31 段吃算力时一键降级，随时能退回 */}
        <View style={styles.choices}>
          <Choice selected={!config.equalizer} onPress={() => { updateSetting({ 'player.soundEffect.equalizer.enable': false }) }}>{t('sound_effect_eq_off')}</Choice>
          <Choice selected={config.equalizer && config.eqMode == 10} onPress={() => { updateSetting(eqModeSetting(10)) }}>{t('sound_effect_eq_mode_10')}</Choice>
          <Choice selected={config.equalizer && config.eqMode == 31} onPress={() => {
            const next = eqModeSetting(31)
            // 第一次切到 31 段、而 31 段还是全平：把十段曲线按对数频率插值搬过来，别让人以为坏了
            if (config.gains31.every(gain => gain == 0) && config.gains.some(gain => gain != 0)) {
              Object.assign(next, eqGains31Setting(importTenToThirtyOne(config.gains)))
            }
            updateSetting(next)
          }}>{t('sound_effect_eq_mode_31')}</Choice>
        </View>
        {config.eqMode == 31
          ? (
              <View>
                <SoundEffectEq31
                  gains={config.gains31}
                  sampleRate={stats?.rate || 48000}
                  onChange={gains => { updateSetting(eqGains31Setting(gains)) }}
                  onCommit={gains => { updateSetting(eqGains31Setting(gains)) }}
                />
                <View style={styles.eqTools}>
                  <Choice onPress={() => { updateSetting(eqGains31Setting(importTenToThirtyOne(config.gains))) }}>{t('sound_effect_eq_import10')}</Choice>
                  <CheckBox check={config.eqHeadroom} label={t('sound_effect_eq_headroom')} onChange={enable => { updateSetting(eqHeadroomSetting(enable)) }} />
                </View>
                <Text size={11} color={theme['c-font-label']} style={styles.hint}>
                  {stats
                    ? (stats.eq31Available
                        ? `C++ 31 段内核${stats.eqNative ? ' · 运行中' : ' · 待命'} · 活跃 ${stats.eqLiveBands ?? 0} 个分节 · 预衰减 ${(stats.eqTrimDb ?? 0).toFixed(1)} dB · ${formatRate(stats.rate)}kHz`
                        : t('sound_effect_eq31_fallback'))
                    : '内核：未连接'}
                </Text>
                <Text size={11} color={theme['c-font-label']} style={styles.hint}>{t('sound_effect_eq31_hint')}</Text>
                <View style={styles.choices}>
                  {equalizerPresets.map(preset => {
                    const gains = frequencies.map(f => Number(preset[('hz' + f) as keyof typeof preset]))
                    // 31 段视图里点预设：把十段曲线搬進 31 段，别把人踢回十段
                    return <Choice key={preset.name}
                      onPress={() => { updateSetting(eqGains31Setting(importTenToThirtyOne(gains))) }}>{translate('sound_effect_eq_' + preset.name)}</Choice>
                  })}
                </View>
              </View>
            )
          : (
              <View>
                <View style={styles.choices}>
                  {equalizerPresets.map(preset => {
                    const gains = frequencies.map(f => Number(preset[('hz' + f) as keyof typeof preset]))
                    return <Choice key={preset.name} selected={config.equalizer && gains.every((gain, i) => gain == config.gains[i])}
                      onPress={() => { updateSetting(equalizerSetting(gains)) }}>{translate('sound_effect_eq_' + preset.name)}</Choice>
                  })}
                </View>
                <View style={styles.sliderGroup}>
                  {frequencies.map((frequency, i) => (
                    <ValueSlider key={frequency} label={frequency < 1000 ? frequency + ' Hz' : frequency / 1000 + ' kHz'} value={config.gains[i]} min={-15} max={15} unit=" dB" disabled={!config.equalizer}
                      onChange={value => { updateSetting({ [bandKey(frequency)]: value }) }} />
                  ))}
                </View>
              </View>
            )}
        <PresetEditor type="equalizer" />
      </Section>

      <Section title={t('sound_effect_convolution')}>
        <View style={styles.choices}>
          <Choice selected={!config.source} onPress={() => { updateSetting({ 'player.soundEffect.convolution.fileName': '' }) }}>{t('sound_effect_off')}</Choice>
          {convolutionPresets.map(preset => (
            <Choice key={preset.name} selected={config.source == preset.source}
              onPress={() => { updateSetting(convolutionSetting(preset.source, preset.mainGain, preset.sendGain)) }}>{translate('sound_effect_ir_' + preset.name)}</Choice>
          ))}
        </View>
        <View style={styles.sliderGroup}>
          <ValueSlider label={t('sound_effect_dry')} value={Math.round(config.dry * 100)} min={0} max={500} unit="%" disabled={!config.source}
            onChange={value => { updateSetting({ 'player.soundEffect.convolution.mainGain': Math.round(value) / 10 }) }} />
          <ValueSlider label={t('sound_effect_wet')} value={Math.round(config.wet * 100)} min={0} max={500} unit="%" disabled={!config.source}
            onChange={value => { updateSetting({ 'player.soundEffect.convolution.sendGain': Math.round(value) / 10 }) }} />
        </View>
        <PresetEditor type="convolution" />
      </Section>

      <Section title={t('sound_effect_surround')}>
        <View style={styles.choices}>
          {SURROUND_MODES.map(item => (
            <Choice key={item.mode} selected={config.surroundMode == item.mode}
              onPress={() => {
                // 蝰蛇为会员功能
                if (item.mode === 4 && !isPro) {
                  toast('蝰蛇空间音效为会员功能，请到「设置 → 关于 → 授权」激活', 'long')
                  return
                }
                // 首次从「关」切到某个模式时直接拉满，保证一耳朵能听出来
                const nextStrength = config.surroundMode == 0 ? 100 : Math.round(config.surroundStrength * 100)
                updateSetting(surroundSetting(item.mode, nextStrength))
              }}>{t(item.key)}</Choice>
          ))}
        </View>
        <View style={styles.sliderGroup}>
          <ValueSlider label={t('sound_effect_surround_strength')} value={Math.round(config.surroundStrength * 100)} min={0} max={100} unit="%" disabled={config.surroundMode == 0}
            onChange={value => { updateSetting(surroundSetting(config.surroundMode, value)) }} />
          <ValueSlider label={t('sound_effect_surround_speed')} value={Math.round(config.surroundSpeed * 100)} min={2} max={60} unit=""
            disabled={!hasRotation(config.surroundMode)} display={value => (value / 100).toFixed(2) + ' Hz'}
            onChange={value => { updateSetting(surroundSpeedSetting(value)) }} />
        </View>
        <Text size={12} color={theme['c-font-label']}>{t('sound_effect_surround_hint')}</Text>
      </Section>

      <Section
        title={t('sound_effect_vinyl')}
        right={<CheckBox check={config.vinylEnable} label={t('sound_effect_enable')}
          onChange={enable => { updateSetting(enable ? vinylSetting(Math.round(config.vinylAmount * 100)) : { 'player.soundEffect.vinyl.enable': false }) }} />}
      >
        <View style={styles.choices}>
          {VINYL_PRESETS.map(item => (
            <Choice key={item.key} selected={config.vinylEnable && Math.round(config.vinylAmount * 100) == item.amount}
              onPress={() => { updateSetting(vinylPresetSetting(item.amount)) }}>{t(item.key)}</Choice>
          ))}
        </View>
        <View style={styles.sliderGroup}>
          <ValueSlider label={t('sound_effect_vinyl_amount')} value={Math.round(config.vinylAmount * 100)} min={0} max={100} unit="%"
            disabled={!config.vinylEnable}
            onChange={value => { updateSetting(vinylAmountSetting(value)) }} />
        </View>
        <View style={styles.choices}>
          <CheckBox check={config.vinylTube} label={t('sound_effect_vinyl_tube')} onChange={on => { updateSetting(vinylToggleSetting('tube', on)) }} />
          <CheckBox check={config.vinylNoise} label={t('sound_effect_vinyl_noise')} onChange={on => { updateSetting(vinylToggleSetting('noise', on)) }} />
          <CheckBox check={config.vinylWow} label={t('sound_effect_vinyl_wow')} onChange={on => { updateSetting(vinylToggleSetting('wow', on)) }} />
          <CheckBox check={config.vinylHiFi} label={t('sound_effect_vinyl_hifi')} onChange={on => { updateSetting(vinylToggleSetting('hifi', on)) }} />
          <CheckBox check={config.vinylLpf} label={t('sound_effect_vinyl_lpf')} onChange={on => { updateSetting(vinylToggleSetting('lpf', on)) }} />
        </View>
        <Text size={11} color={theme['c-font-label']} style={styles.hint}>
          {stats
            ? (stats.vinylAvailable
                ? `C++ 味精内核${stats.vinylNative ? ' · 运行中' : ' · 待命'} · 过采样 ${stats.vinylOs ?? 0}× · 驱动 ${(stats.vinylDriveDb ?? 0).toFixed(1)} dB · 嘶声 ${(stats.vinylHissDb ?? -86).toFixed(0)} dBFS · ${formatRate(stats.rate)}kHz`
                : t('sound_effect_vinyl_fallback'))
            : '内核：未连接'}
        </Text>
        <Text size={11} color={theme['c-font-label']} style={styles.hint}>{t('sound_effect_vinyl_hint')}</Text>
      </Section>

      <Section
        title={t('sound_effect_head_track')}
        right={<CheckBox check={config.headTrack} label={t('sound_effect_enable')} onChange={enable => { updateSetting({ 'player.soundEffect.headTrack.enable': enable }) }} />}
      >
        <Text size={12} color={theme['c-font-label']} style={styles.hint}>{t('sound_effect_head_track_hint')}</Text>
        <Text size={11} color={theme['c-font-label']} style={styles.stats} numberOfLines={1} ellipsizeMode="tail">
          {stats
            ? [
              stats.headTrackLoaded ? (stats.headTrackReady ? `HRTF 已就绪` : `HRTF 初始化中`) : `HRTF 不可用`,
              stats.headset ? `耳机已连接` : `未接耳机`,
              `偏航 ${Math.round(stats.headTrackYaw)}°`,
            ].join(' · ')
            : '—'}
        </Text>
        {stats && !stats.headTrackLoaded
          ? <Text size={11} color={theme['c-font-label']} numberOfLines={2}>{stats.headTrackError || stats.headTrackBackend}</Text>
          : null}
      </Section>

      <Section
        title="重低音震动"
        right={<CheckBox check={hapticEnable} label={t('sound_effect_enable')} onChange={enable => { updateSetting({ 'player.hapticBass.enable': enable }) }} />}
      >
        <Text size={12} color={theme['c-font-label']} style={styles.hint}>
          跟随音乐低频驱动马达，鼓点会被“震”出来。低频少的曲子几乎无感；手机会比平时多耗一点电。
        </Text>
        <ValueSlider label="震动强度" value={hapticStrength} min={10} max={100} unit="%" disabled={!hapticEnable}
          onChange={value => { updateSetting({ 'player.hapticBass.strength': value }) }} />
      </Section>
    </View>
  )
}

export default () => {
  const t = useI18n()
  const theme = useTheme()
  const ref = useRef<PopupType>(null)
  const [mounted, setMounted] = useState(false)
  const config = useSoundEffectConfig()
  if (!isSoundEffectSupported) return null
  const show = () => {
    setMounted(true)
    requestAnimationFrame(() => { ref.current?.setVisible(true) })
  }
  const enabled = [
    config.equalizer ? `${t('sound_effect_equalizer')} ${config.eqMode == 31 ? '31' : '10'}` : null,
    config.source ? t('sound_effect_convolution') : null,
    config.surroundMode ? t('sound_effect_surround') : null,
    config.headTrack ? t('sound_effect_head_track') : null,
    config.vinylEnable && config.vinylAmount > 0 ? `${t('sound_effect_vinyl')} ${Math.round(config.vinylAmount * 100)}%` : null,
  ].filter(Boolean)
  return (
    <View style={styles.entry}>
      <Choice onPress={show}>{t('sound_effect_title')}</Choice>
      <Text size={12} color={theme['c-font-label']} style={styles.entrySummary}>
        {enabled.length ? enabled.join(' · ') : t('sound_effect_all_off')}
      </Text>
      {mounted && <Popup ref={ref} title={t('sound_effect_title')}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <SoundEffectPanel />
        </ScrollView>
      </Popup>}
    </View>
  )
}

const styles = createStyle({
  entry: { paddingVertical: 6, alignItems: 'flex-start' },
  entrySummary: { marginTop: 6 },
  content: { paddingHorizontal: 16, paddingBottom: 28 },
  section: { paddingTop: 14, marginTop: 14, borderTopWidth: 1 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 34 },
  sectionTitle: { flexShrink: 1 },
  sectionActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 6 },
  choice: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8, marginBottom: 8 },
  sliderGroup: { paddingTop: 4 },
  eqTools: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingTop: 6 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
  sliderLabel: { width: 66 },
  sliderValue: { width: 54, textAlign: 'right' },
  saveRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 10 },
  hint: { paddingVertical: 8, lineHeight: 18 },
  topMeta: { flexDirection: 'row', alignItems: 'center', minHeight: 28, paddingTop: 1, paddingBottom: 1 },
  rateTag: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingLeft: 9, paddingRight: 9, paddingTop: 3, paddingBottom: 3, marginRight: 8, flexShrink: 0 },
  rateValue: { fontWeight: '600', letterSpacing: 0.2 },
  rateCaption: { marginLeft: 6, opacity: 0.72 },
  stats: { flexShrink: 1, lineHeight: 16 },
  status: { gap: 6, paddingVertical: 6, alignItems: 'flex-start' },
})
