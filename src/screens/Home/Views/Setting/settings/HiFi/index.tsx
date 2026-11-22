import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeviceEventEmitter, Modal, NativeModules, ScrollView, TouchableOpacity, View } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'

import Section from '../../components/Section'
import SubTitle from '../../components/SubTitle'
import BtCard from './BtCard'
import Text from '@/components/common/Text'
import Gradient from '@/components/common/Gradient'
import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import { importLocalMusicFolder } from '@/core/localImport'
import { DEFAULT_CUE_EXPORT_DIR, exportCueSheet, findCueFiles, formatCueList } from '@/core/cue'
import { applyHiRes, getSoundEffectStats, normalizeHiResTarget, type SoundEffectStats } from '@/plugins/player/soundEffect'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'
import { updateSetting } from '@/core/common'

// ---------------------------------------------------------------------------
// 【Hi-Fi 解析中枢】
// 三大解析链集中到一张卡片：
//   ① 局域网传歌（LanShareModule，纯传输，不碰解码）
//   ② Hi-Res 插值升频（C++ 多相 sinc 重采样，由原生侧自理，这里只发开关）
//   ③ CUE 分轨（cue 解析 + 原生切片，只读文件不改音频管线）
// 全部只调既有 JS 接口：不动底层 C++ / JNI / 音频处理逻辑。
// ---------------------------------------------------------------------------

interface LanInfo {
  running: boolean
  ip: string
  port: number
  url: string
  dir: string
  files: string[]
}

interface LanBridge {
  start: () => Promise<LanInfo>
  stop: () => Promise<void>
  getStatus: () => Promise<LanInfo>
}

const lan = NativeModules.LanShareModule as LanBridge | undefined

const HIRES_RATES = [192000, 96000, 48000]

const formatSize = (size: number): string => {
  if (!size || size < 0) return ''
  if (size > 1048576) return (size / 1048576).toFixed(1) + ' MB'
  if (size > 1024) return Math.round(size / 1024) + ' KB'
  return size + ' B'
}

/** 96/192 不留小数，44.1 这类保留一位 */
const formatKhz = (rate: number): string => {
  const value = Math.round(Number(rate) || 0)
  if (value <= 0) return '--'
  return value % 1000 == 0 ? String(value / 1000) : (value / 1000).toFixed(1)
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()

  // ---------------- 局域网传歌 ----------------
  const [lanInfo, setLanInfo] = useState<LanInfo | null>(null)
  const [lanBusy, setLanBusy] = useState(false)
  const [lanModal, setLanModal] = useState(false)
  const [received, setReceived] = useState<string[]>([])

  // ---------------- Hi-Res 插值升频 ----------------
  const hiresEnabled = useSettingValue('player.hires.enable')
  const hiresTarget = useSettingValue('player.hires.target')
  const [soundStats, setSoundStats] = useState<SoundEffectStats | null>(null)
  // HiRes.destroy() 会把 activeOutputRate 清零，3s 轮询很容易抓到 0；记住最近一次真正生效的输出率
  const lastHiresOutputRef = useRef(0)

  // ---------------- CUE 分轨 ----------------
  const choosePathRef = useRef<ChoosePathType>(null)
  const [cueFiles, setCueFiles] = useState<string[]>([])
  const [cueModal, setCueModal] = useState(false)
  const [cueBusy, setCueBusy] = useState('')
  const [cueDir, setCueDir] = useState('')

  const refreshStatus = useCallback(async() => {
    if (!lan) return
    try {
      const info = await lan.getStatus()
      setLanInfo(info.running ? info : null)
    } catch {}
  }, [])

  useEffect(() => {
    void refreshStatus()
    const sub = DeviceEventEmitter.addListener('YieyuLanShareUpload', (file: { name?: string, size?: number }) => {
      const name = file?.name ?? '文件'
      const size = formatSize(file?.size ?? 0)
      setReceived(prev => [(size ? size + '  ' : '') + name, ...prev].slice(0, 30))
      void refreshStatus()
    })
    return () => { sub.remove() }
  }, [refreshStatus])

  // 升频自检：原生侧真实的输入/输出采样率（只读状态，不改管线）
  useEffect(() => {
    let alive = true
    const pull = async() => {
      const stats = await getSoundEffectStats()
      if (alive) setSoundStats(stats)
    }
    void pull()
    const timer = setInterval(() => { void pull() }, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // 输出采样率只在「真正生效」时更新；轮询抓到 0 时沿用上一次，绝不把源 44.1 当主值
  useEffect(() => {
    if (!soundStats) return
    if (!soundStats.hiresEnabled) {
      lastHiresOutputRef.current = 0
      return
    }
    if (soundStats.hiresOutputRate > 0) lastHiresOutputRef.current = soundStats.hiresOutputRate
  }, [soundStats])

  const startLan = useCallback(async() => {
    if (!lan) {
      toast('当前版本不含局域网传歌模块', 'long')
      return
    }
    setLanBusy(true)
    try {
      const info = await lan.start()
      setLanInfo(info)
      setLanModal(true)
      if (!info.url) toast('没拿到 Wi-Fi 地址，请确认已连上同一局域网', 'long')
    } catch (error) {
      toast('启动失败：' + ((error as Error)?.message ?? '未知错误'), 'long')
    } finally {
      setLanBusy(false)
    }
  }, [])

  const stopLan = useCallback(async() => {
    try { await lan?.stop() } catch {}
    setLanInfo(null)
    setLanModal(false)
  }, [])

  const copyUrl = useCallback(() => {
    const url = lanInfo?.url
    if (!url) return
    Clipboard.setString(url)
    toast('已复制，粘到电脑浏览器打开')
  }, [lanInfo])

  const importReceived = useCallback(async() => {
    const dir = lanInfo?.dir
    if (!dir) return
    try {
      const count = await importLocalMusicFolder(dir)
      toast(count > 0 ? `已导入 ${count} 首到「本地音乐」` : '目录里还没收到可导入的音频', 'long')
    } catch (error) {
      toast('导入失败：' + ((error as Error)?.message ?? '未知错误'), 'long')
    }
  }, [lanInfo])

  const toggleHiRes = useCallback(() => {
    const enable = !(hiresEnabled === true)
    updateSetting({ 'player.hires.enable': enable })
    // 采样率要重新 configure，原生侧会重建一次音频管线
    setTimeout(() => { applyHiRes() }, 60)
    toast(enable ? `Hi-Res 已开启（目标 ${normalizeHiResTarget(hiresTarget) / 1000} kHz）` : 'Hi-Res 已关闭', 'long')
  }, [hiresEnabled, hiresTarget])

  const pickRate = useCallback((rate: number) => {
    updateSetting({ 'player.hires.target': rate })
    if (hiresEnabled === true) setTimeout(() => { applyHiRes() }, 60)
  }, [hiresEnabled])

  const pickCueDir = useCallback(() => {
    choosePathRef.current?.show({ title: '选择含 .cue 的目录', dirOnly: true })
  }, [])

  const scanCueDir = useCallback(async(dirPath: string) => {
    setCueBusy('正在扫描 CUE…')
    try {
      const files = await findCueFiles(dirPath)
      setCueDir(dirPath)
      setCueFiles(files)
      if (!files.length) {
        toast('这个目录里没有 .cue 文件', 'long')
        return
      }
      setCueModal(true)
    } catch (error) {
      toast('扫描失败：' + ((error as Error)?.message ?? '未知错误'), 'long')
    } finally {
      setCueBusy('')
    }
  }, [])

  const exportCue = useCallback(async(cuePath: string) => {
    if (cueBusy) return
    setCueBusy('准备导出…')
    try {
      const result = await exportCueSheet(cuePath, {
        outputDir: DEFAULT_CUE_EXPORT_DIR,
        onProgress: (done, total, label) => {
          setCueBusy(`正在导出 ${done}/${total} · ${label}`)
        },
      })
      setCueBusy('')
      if (result.files.length) {
        toast(`已导出 ${result.files.length} 首到 ${DEFAULT_CUE_EXPORT_DIR}`, 'long')
      } else {
        toast('没有导出任何曲目' + (result.errors.length ? `：${result.errors[0]}` : ''), 'long')
      }
      if (result.errors.length) {
        toast(`${result.errors.length} 首失败：${result.errors[0]}`, 'long')
      }
    } catch (error) {
      setCueBusy('')
      toast('导出失败：' + ((error as Error)?.message ?? '未知错误'), 'long')
    }
  }, [cueBusy])

  const exportAllCue = useCallback(async() => {
    if (cueBusy) return
    for (const cuePath of cueFiles) {
      await exportCue(cuePath)
    }
    if (cueDir) toast('全部 CUE 处理完毕', 'long')
  }, [cueBusy, cueFiles, cueDir, exportCue])

  const hiresStatus = useMemo(() => {
    if (hiresEnabled !== true) return '已关闭'
    if (!soundStats) return '状态未知（未拿到原生自检数据）'
    if (!soundStats.hiresSupported) return `不可用：${soundStats.hiresError || '当前 ABI 没有原生库'}`
    const output = soundStats.hiresOutputRate > 0 ? soundStats.hiresOutputRate : lastHiresOutputRef.current
    const effective = typeof soundStats.hiresEffectiveTarget == 'number' ? soundStats.hiresEffectiveTarget : soundStats.hiresTarget
    const degraded = soundStats.hiresDegraded === true || effective < soundStats.hiresTarget
    const degradeTag = !degraded ? ''
      : effective <= 0 ? ' · 已降级(直通)'
      : ` · 已降级(目标 ${formatKhz(soundStats.hiresTarget)}kHz)`
    if (output > 0) {
      return `${formatKhz(output)} kHz${soundStats.hiresInputRate > 0 ? ` · 源 ${formatKhz(soundStats.hiresInputRate)} kHz` : ''}${soundStats.hiresFrames > 0 ? ` · 已处理 ${soundStats.hiresFrames} 帧` : ''}${degradeTag}`
    }
    return `目标 ${formatKhz(soundStats.hiresTarget)} kHz${degraded ? '' : ' · 切歌后生效'}${degradeTag}`
  }, [hiresEnabled, soundStats])

  const hiresActive = hiresEnabled === true &&
    ((soundStats?.hiresOutputRate ?? 0) > 0 || lastHiresOutputRef.current > 0)

  const lanOn = !!lanInfo?.url

  return (
    <>
      <Section title={t('setting_hifi')}>
        <Text size={11} style={styles.lead} color={theme['c-500']}>
          四条链路：蓝牙 → 传输 → 升频 → 分轨。全部复用既有原生能力，本页只做开关与状态回显。
        </Text>

        {/* ---------------- ⓪ 蓝牙高音质与同步 ---------------- */}
        <SubTitle title="蓝牙高音质与同步">
          <BtCard />
        </SubTitle>

        {/* ---------------- ① 局域网传歌 ---------------- */}
        <SubTitle title="局域网传歌">
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <View style={styles.cardTitleRow}>
                <Text size={14} style={styles.cardTitle}>手机 ⇄ 电脑</Text>
                <View style={[styles.tag, lanOn ? styles.tagOn : null]}>
                  <Text size={10} style={[styles.tagText, lanOn ? styles.tagTextOn : null]}>
                    {lanOn ? '服务运行中' : '未开启'}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={lanOn ? () => setLanModal(true) : startLan}
                disabled={lanBusy}
                activeOpacity={0.6}
              >
                <Text size={13} color={theme['c-primary-font']}>
                  {lanBusy ? '启动中…' : lanOn ? '查看地址' : '启动'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text size={12} style={styles.hint} color={theme['c-500']}>
              电脑与手机连同一个 Wi-Fi，电脑浏览器打开给出的地址，把歌拖进去；传完点「导入」直接进本地歌单。
            </Text>
            {lanOn
              ? <Text size={11} style={styles.mono} color={theme['c-primary-font']} numberOfLines={1}>{lanInfo?.url}</Text>
              : null}
          </View>
        </SubTitle>

        {/* ---------------- ② Hi-Res 插值升频 ---------------- */}
        <SubTitle title="Hi-Res 插值升频">
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <View style={styles.cardTitleRow}>
                <Text size={14} style={styles.cardTitle}>C++ 多相 sinc 重采样</Text>
                <View style={[styles.tag, hiresActive ? styles.tagOn : null]}>
                  <Text size={10} style={[styles.tagText, hiresActive ? styles.tagTextOn : null]}>
                    {hiresActive ? '运行中' : (hiresEnabled === true ? '已开启' : '关闭')}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={toggleHiRes} activeOpacity={0.7}>
                <Gradient
                  colors={hiresEnabled === true ? ['#6EE7B7', '#3B82F6'] : ['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.12)']}
                  direction="horizontal"
                  steps={14}
                  style={styles.switchWrap}
                >
                  <View style={[styles.switchKnob, hiresEnabled === true ? styles.switchKnobOn : null]} />
                </Gradient>
              </TouchableOpacity>
            </View>
            <Text size={12} style={styles.hint} color={theme['c-500']}>
              把解码出来的 PCM 插到高采样率再交给 AudioTrack，不再吃系统那条廉价线性插值。
            </Text>
            <View style={styles.rateRow}>
              {HIRES_RATES.map(rate => {
                const active = normalizeHiResTarget(hiresTarget) === rate
                return (
                  <TouchableOpacity key={rate} onPress={() => { pickRate(rate) }} style={[styles.rateChip, active ? styles.rateChipOn : null]} activeOpacity={0.7}>
                    <Text size={12} style={[styles.rateText, active ? styles.rateTextOn : null]}>{(rate / 1000).toFixed(0)} kHz</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
            <Text size={11} style={[styles.stats, hiresActive ? styles.statsActive : null]}>{hiresStatus}</Text>
          </View>
        </SubTitle>

        {/* ---------------- ③ CUE 分轨 ---------------- */}
        <SubTitle title="CUE 分轨">
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <View style={styles.cardTitleRow}>
                <Text size={14} style={styles.cardTitle}>整轨 FLAC / WAV</Text>
                <View style={styles.tag}>
                  <Text size={10} style={styles.tagText}>无损切片</Text>
                </View>
              </View>
              <TouchableOpacity onPress={pickCueDir} disabled={!!cueBusy} activeOpacity={0.6}>
                <Text size={13} color={theme['c-primary-font']}>选目录</Text>
              </TouchableOpacity>
            </View>
            <Text size={12} style={styles.hint} color={theme['c-500']}>
              .cue 解析后直接拆成一首一首（可单独播放 / 切歌）；也可以导出真切片 WAV 到 {DEFAULT_CUE_EXPORT_DIR}。
            </Text>
            {cueBusy
              ? <Text size={11} style={styles.stats}>{cueBusy}</Text>
              : null}
            {cueFiles.length > 0 && !cueModal
              ? (
                  <TouchableOpacity onPress={() => setCueModal(true)} activeOpacity={0.6}>
                    <Text size={12} style={styles.link} color={theme['c-primary-font']}>
                      上次扫描到 {cueFiles.length} 个 .cue，点这里继续处理
                    </Text>
                  </TouchableOpacity>
                )
              : null}
          </View>
        </SubTitle>
      </Section>

      {/* ---------------- 局域网地址弹窗 ---------------- */}
      <Modal visible={lanModal} transparent animationType="fade" onRequestClose={() => setLanModal(false)}>
        <View style={styles.mask}>
          <View style={[styles.dialog, { backgroundColor: theme['c-content-background'] }]}>
            <Text size={16} style={styles.dialogTitle}>局域网传歌</Text>
            <Text size={15} style={[styles.url, { color: theme['c-primary-font'] }]}>{lanInfo?.url ?? ''}</Text>
            <View style={styles.actions}>
              <TouchableOpacity style={styles.btn} onPress={copyUrl}>
                <Text size={13} color={theme['c-primary-font']}>复制地址</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn} onPress={importReceived}>
                <Text size={13} color={theme['c-primary-font']}>导入收到的歌</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn} onPress={stopLan}>
                <Text size={13}>关闭服务</Text>
              </TouchableOpacity>
            </View>
            <Text size={11} style={styles.hint} color={theme['c-500']}>保存目录：{lanInfo?.dir ?? '-'}</Text>
            <ScrollView style={styles.listBox}>
              {received.length === 0
                ? <Text size={11} style={styles.hint} color={theme['c-500']}>还没有收到文件…</Text>
                : received.map((line, index) => <Text size={12} key={index} style={styles.listItem}>{line}</Text>)}
            </ScrollView>
            <TouchableOpacity style={styles.close} onPress={() => setLanModal(false)}>
              <Text size={13}>收起（服务继续运行）</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ---------------- CUE 列表弹窗 ---------------- */}
      <Modal visible={cueModal} transparent animationType="fade" onRequestClose={() => setCueModal(false)}>
        <View style={styles.mask}>
          <View style={[styles.dialog, { backgroundColor: theme['c-content-background'] }]}>
            <Text size={16} style={styles.dialogTitle}>CUE 分轨（{cueFiles.length}）</Text>
            <ScrollView style={styles.listBox}>
              {cueFiles.map(cuePath => (
                <TouchableOpacity key={cuePath} style={styles.cueItem} onPress={() => { void exportCue(cuePath) }} disabled={!!cueBusy}>
                  <Text size={13} style={styles.cueName} numberOfLines={1}>{formatCueList(cuePath)}</Text>
                  <Text size={13} style={styles.cueAction} color={theme['c-primary-font']}>导出</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {cueBusy ? <Text size={11} style={styles.stats}>{cueBusy}</Text> : null}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.btn} onPress={exportAllCue} disabled={!!cueBusy}>
                <Text size={13} color={theme['c-primary-font']}>全部导出</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn} onPress={() => setCueModal(false)}>
                <Text size={13}>关闭</Text>
              </TouchableOpacity>
            </View>
            <Text size={11} style={styles.hint} color={theme['c-500']}>输出：{DEFAULT_CUE_EXPORT_DIR}／&lt;CUE 文件名&gt;／NN 曲名.wav</Text>
          </View>
        </View>
      </Modal>

      <ChoosePath ref={choosePathRef} onConfirm={(path: string) => { void scanCueDir(path) }} />
    </>
  )
})

const styles = createStyle({
  lead: {
    lineHeight: 17,
    marginBottom: 2,
    letterSpacing: 0.2,
  },
  card: {
    marginTop: 2,
    marginBottom: 10,
    padding: 13,
    borderRadius: 16,
    backgroundColor: 'rgba(127,127,127,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.20)',
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  cardTitle: {
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
  hint: {
    lineHeight: 18,
    marginTop: 2,
  },
  mono: {
    marginTop: 6,
  },
  link: {
    marginTop: 8,
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
  rateRow: {
    flexDirection: 'row',
    marginTop: 10,
  },
  rateChip: {
    marginRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(127,127,127,0.16)',
  },
  rateChipOn: {
    backgroundColor: 'rgba(110,231,183,0.20)',
  },
  rateText: {
    opacity: 0.72,
  },
  rateTextOn: {
    color: '#6EE7B7',
    opacity: 1,
    fontWeight: '600',
  },
  stats: {
    marginTop: 8,
    opacity: 0.75,
  },
  statsActive: {
    color: '#6EE7B7',
    opacity: 1,
    fontWeight: '600',
  },
  mask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20,
  },
  dialog: {
    borderRadius: 16,
    padding: 18,
    maxHeight: '80%',
  },
  dialogTitle: {
    fontWeight: 'bold',
    marginBottom: 10,
  },
  url: {
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 10,
  },
  btn: {
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(127,127,127,0.18)',
  },
  listBox: {
    maxHeight: 180,
    marginTop: 6,
  },
  listItem: {
    opacity: 0.8,
    paddingTop: 2,
    paddingBottom: 2,
  },
  close: {
    marginTop: 12,
    paddingTop: 10,
    paddingBottom: 10,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: 'rgba(127,127,127,0.18)',
  },
  cueItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 8,
  },
  cueName: {
    flexShrink: 1,
  },
  cueAction: {
    marginLeft: 10,
  },
})
