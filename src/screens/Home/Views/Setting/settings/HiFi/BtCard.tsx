import { memo, useCallback, useEffect, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import Text from '@/components/common/Text'
import Gradient from '@/components/common/Gradient'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { getBtState, resetBtAutoMode, subscribeBtState } from '@/core/btMode'
import { openDeveloperOptions, type BtAudioState } from '@/utils/nativeModules/btAudio'
import { createStyle, toast } from '@/utils/tools'

/** 微调步进：蓝牙延迟本身有 ±30ms 的听感离散，25ms 一档刚好够用 */
const STEP = 25
const DEFAULT_COMPENSATION = 175

/**
 * 蓝牙高音质与同步（Aurora-26）
 *
 * 事实约束：Android 没有公开 API 能让 App 直接选 LDAC / aptX（getCodecStatus / setCodecConfigPreference
 * 都是 @SystemApi，需系统签名），所以这里做的是「自动把我们的管线对齐 + 歌词延迟补偿 + 给用户入口」。
 */
export default memo(() => {
  const theme = useTheme()
  const autoMode = useSettingValue('bt.autoMode')
  const compensation = useSettingValue('bt.lyricCompensation') ?? DEFAULT_COMPENSATION
  const [bt, setBt] = useState<BtAudioState>(getBtState())

  useEffect(() => subscribeBtState(setBt), [])

  const toggleAuto = useCallback(() => {
    const next = !(autoMode === true)
    updateSetting({ 'bt.autoMode': next })
    if (!next) resetBtAutoMode()
    toast(next ? '蓝牙自动优化已开启（连上耳机自动关升频 / 关 offload）' : '蓝牙自动优化已关闭', 'long')
  }, [autoMode])

  const changeCompensation = useCallback((delta: number) => {
    const next = Math.max(0, Math.min(600, Math.round((Number(compensation) || 0) + delta)))
    updateSetting({ 'bt.lyricCompensation': next })
  }, [compensation])

  const resetCompensation = useCallback(() => {
    updateSetting({ 'bt.lyricCompensation': DEFAULT_COMPENSATION })
  }, [])

  const openDev = useCallback(() => {
    void openDeveloperOptions().then((ok) => {
      if (!ok) toast('没打开开发者选项，请到 系统设置 → 关于手机 里手动开启', 'long')
    })
  }, [])

  const connected = bt.connected

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <Text size={14} style={styles.title}>手机 ⇄ 蓝牙耳机</Text>
          <View style={[styles.tag, connected ? styles.tagOn : null]}>
            <Text size={10} style={[styles.tagText, connected ? styles.tagTextOn : null]}>
              {connected ? '蓝牙输出中' : '未连接'}
            </Text>
          </View>
        </View>
        <TouchableOpacity onPress={toggleAuto} activeOpacity={0.7}>
          <Gradient
            colors={autoMode === true ? ['#6EE7B7', '#3B82F6'] : ['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.12)']}
            direction="horizontal"
            steps={14}
            style={styles.switchWrap}
          >
            <View style={[styles.switchKnob, autoMode === true ? styles.switchKnobOn : null]} />
          </Gradient>
        </TouchableOpacity>
      </View>

      {connected && bt.name
        ? <Text size={11} style={styles.device} color={theme['c-primary-font']} numberOfLines={1}>{bt.name}</Text>
        : null}

      <Text size={12} style={styles.hint} color={theme['c-500']}>
        蓝牙一插上就自动关掉 Hi-Res 插值升频与 audio offload：LDAC 顶到 96kHz、aptX 顶到 48kHz，
        系统还要再降一次采样，我们再加 192kHz 只会多两次重采样。
      </Text>

      <View style={styles.divider} />

      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text size={13} style={styles.rowTitle}>歌词延迟补偿</Text>
          <Text size={11} style={styles.hint} color={theme['c-500']}>
            AAC / SBC 耳机链路延迟典型 150~200ms，歌词会「抢拍」。这里让歌词往后推，推到和你听到的对上。
          </Text>
        </View>
        <Text size={14} style={styles.value} color={theme['c-primary-font']}>{`-${Math.round(Number(compensation) || 0)}ms`}</Text>
      </View>

      <View style={styles.btns}>
        <TouchableOpacity style={styles.btn} onPress={() => { changeCompensation(-STEP) }} activeOpacity={0.6}>
          <Text size={12}>{`-${STEP}ms`}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => { changeCompensation(STEP) }} activeOpacity={0.6}>
          <Text size={12}>{`+${STEP}ms`}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={resetCompensation} activeOpacity={0.6}>
          <Text size={12} color={theme['c-primary-font']}>{`重置 ${DEFAULT_COMPENSATION}ms`}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={openDev} activeOpacity={0.6}>
          <Text size={12} color={theme['c-primary-font']}>开发者选项</Text>
        </TouchableOpacity>
      </View>

      <Text size={11} style={styles.hint} color={theme['c-500']}>
        想确认自己耳机跑的是 AAC 还是 aptX：开发者选项 → 蓝牙音频编解码器。
        App 无权限替你切换编码器（Android 只给系统签名应用开放该接口），但这里的补偿与升频策略会自动跟着生效。
      </Text>
    </View>
  )
})

const styles = createStyle({
  card: {
    marginTop: 2,
    marginBottom: 10,
    padding: 13,
    borderRadius: 16,
    backgroundColor: 'rgba(127,127,127,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.20)',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  title: {
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  tag: {
    marginLeft: 8,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 7,
    paddingRight: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(127,127,127,0.18)',
  },
  tagOn: {
    backgroundColor: 'rgba(110,231,183,0.18)',
  },
  tagText: {
    opacity: 0.7,
  },
  tagTextOn: {
    color: '#6EE7B7',
    opacity: 1,
  },
  device: {
    marginTop: 2,
    marginBottom: 2,
  },
  hint: {
    lineHeight: 18,
    marginTop: 2,
  },
  divider: {
    height: 1,
    marginTop: 10,
    marginBottom: 10,
    backgroundColor: 'rgba(127,127,127,0.16)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  rowText: {
    flexShrink: 1,
    paddingRight: 10,
  },
  rowTitle: {
    fontWeight: '600',
  },
  value: {
    fontWeight: '700',
  },
  btns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 8,
  },
  btn: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 11,
    paddingRight: 11,
    borderRadius: 10,
    backgroundColor: 'rgba(127,127,127,0.16)',
  },
  switchWrap: {
    width: 46,
    height: 26,
    borderRadius: 13,
    justifyContent: 'center',
  },
  switchKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#F8FAFC',
    marginLeft: 3,
  },
  switchKnobOn: {
    marginLeft: 23,
  },
})
