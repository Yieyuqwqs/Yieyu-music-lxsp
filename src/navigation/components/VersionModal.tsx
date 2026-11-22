import { useCallback, useEffect, useMemo, useState } from 'react'
import { BackHandler, Pressable, ScrollView, View } from 'react-native'

import { sizeFormate } from '@/utils'
import { compareVersion } from '@/utils/versionCompare'
import {
  getInstalledVersionCode,
  getInstalledVersionName,
  normalizeInstalledCode,
  parseVersionName,
} from '@/utils/installedVersion'
import Text from '@/components/common/Text'
import Gradient from '@/components/common/Gradient'
import { updateApp } from '@/utils/version'
import { createStyle, openUrl } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useGuardInfo } from '@/store/guard/hook'
import { UPDATE_DOWNLOAD_URL } from '@/config/updateGuard'
import { type VersionInfo } from '@/store/version/state'
import { useVersionDownloadProgressUpdated, useVersionInfo, useVersionInfoIgnoreVersionUpdated } from '@/store/version/hook'
import { checkUpdate, downloadUpdate, hideModal, setIgnoreVersion } from '@/core/version'

/** Aurora 系列深色毛玻璃配色（不跟随浅色主题，弹窗本身就是一块"玻璃"） */
const GLASS = {
  card: 'rgba(17,19,27,0.93)',
  panel: 'rgba(255,255,255,0.055)',
  panelBorder: 'rgba(255,255,255,0.10)',
  line: 'rgba(255,255,255,0.08)',
  title: '#F4F6FA',
  text: 'rgba(233,238,247,0.86)',
  dim: 'rgba(203,213,225,0.55)',
  dimmer: 'rgba(203,213,225,0.38)',
  warn: '#FFC46B',
  ok: '#5BE7A9',
}

const clamp255 = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const parseRgb = (color?: string): [number, number, number] => {
  if (!color) return [77, 175, 124]
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color.trim())
  if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
  return [77, 175, 124]
}

/** 把主题主色变成一条渐变（主题色 → 提亮 → 收深），保证按钮始终有"渐变感" */
const accentStops = (primary?: string): string[] => {
  const [r, g, b] = parseRgb(primary)
  return [
    `rgb(${clamp255(r + 46)}, ${clamp255(g + 38)}, ${clamp255(b + 52)})`,
    `rgb(${r}, ${g}, ${b})`,
    `rgb(${clamp255(r * 0.72)}, ${clamp255(g * 0.72)}, ${clamp255(b * 0.82)})`,
  ]
}

const fallbackVer = typeof process.versions?.app === 'string' ? process.versions.app : ''

const StatusDot = ({ color }: { color: string }) => (
  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginRight: 6 }} />
)

/** 更新日志：'- ' 开头渲染成圆点列表，其余按段落 */
const ChangeLog = ({ text }: { text: string }) => {
  const lines = useMemo(() => text.split('\n').map(line => line.trim()).filter(Boolean), [text])
  return (
    <View>
      {lines.map((line, index) => {
        const bullet = /^[-*·]\s*/.test(line)
        const content = bullet ? line.replace(/^[-*·]\s*/, '') : line
        const isHead = !bullet && index === 0
        return (
          <View key={index} style={styles.logLine}>
            {bullet
              ? <View style={styles.logDot} />
              : null}
            <Text
              selectable
              style={[styles.logText, isHead ? styles.logHead : null, bullet ? null : styles.logPlain]}
            >
              {content}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

const HistoryItem = ({ version, desc }: VersionInfo) => (
  <View style={styles.historyItem}>
    <View style={styles.historyHead}>
      <Text style={styles.historyVer}>v{version}</Text>
    </View>
    <Text style={styles.historyDesc}>{desc}</Text>
  </View>
)

const VersionModal = ({ componentId }: { componentId: string }) => {
  const theme = useTheme()
  const guard = useGuardInfo()
  // 强更死锁：本机版本低于云端 minSupportedVersion 时，这个弹窗也切到不可关闭形态
  const forceUpdate = guard.status === 'blocked'
  const versionInfo = useVersionInfo()
  const progress = useVersionDownloadProgressUpdated()
  const ignoreVersion = useVersionInfoIgnoreVersionUpdated()

  const [localVersion, setLocalVersion] = useState(fallbackVer)
  const [localCode, setLocalCode] = useState(0)

  // 版本号一律以 PackageManager 为准，JS 包里的 package.json 只当兜底
  useEffect(() => {
    let alive = true
    void Promise.all([getInstalledVersionName(), getInstalledVersionCode()]).then(([name, code]) => {
      if (!alive) return
      if (name) setLocalVersion(name)
      setLocalCode(normalizeInstalledCode(code))
    })
    return () => { alive = false }
  }, [])

  const stops = useMemo(() => accentStops(theme['c-primary']), [theme])
  const localMeta = useMemo(() => parseVersionName(localVersion), [localVersion])
  const remoteVersion = versionInfo.newVersion?.version ?? ''
  // 云端比本机旧时，core/version 会把展示版本夹回本机，旧值单独记在 remoteVersion 上
  const staleVersion = versionInfo.remoteVersion ?? ''
  const staleRemote = staleVersion !== '' && compareVersion(localVersion, staleVersion) > 0
  const remoteMeta = useMemo(() => parseVersionName(remoteVersion), [remoteVersion])

  const hasUpdate = !staleRemote && !!remoteVersion && compareVersion(localVersion, remoteVersion) < 0
  const showRemote = hasUpdate

  const status = versionInfo.status
  const downloading = status === 'downloading'
  const downloaded = status === 'downloaded'
  const percent = progress.total > 0 ? Math.min(100, Math.max(0, progress.current / progress.total * 100)) : 0

  const view = useMemo(() => {
    if (forceUpdate) {
      return {
        title: '必须更新才能继续',
        subtitle: `当前 v${localVersion} 低于最低支持 v${guard.minVersion || '—'}，旧版接口已停止服务`,
        primary: `立即下载${guard.latestVersion ? ` v${guard.latestVersion}` : ''}`,
        primaryKind: 'force' as const,
        tone: GLASS.warn,
      }
    }
    if (versionInfo.isUnknown) {
      return {
        title: '检查更新失败',
        subtitle: '网络或云端元数据暂时不可用，本机版本不受影响',
        primary: '重新检查',
        primaryKind: 'check' as const,
        tone: GLASS.warn,
      }
    }
    if (versionInfo.isLatest || staleRemote || !hasUpdate) {
      return {
        title: status === 'checking' ? '正在检查更新…' : '已是最新版本',
        subtitle: status === 'checking' ? '正在和云端比对版本号' : '本机已是最新，无需更新',
        primary: status === 'checking' ? '检查中…' : '重新检查',
        primaryKind: 'check' as const,
        tone: GLASS.ok,
      }
    }
    switch (status) {
      case 'downloading':
        return {
          title: '正在下载更新',
          subtitle: `${sizeFormate(progress.current)} / ${sizeFormate(progress.total)} · ${percent.toFixed(1)}%`,
          primary: '下载中…',
          primaryKind: 'busy' as const,
          tone: GLASS.warn,
        }
      case 'downloaded':
        return {
          title: '更新已就绪',
          subtitle: '点击「立即安装」完成升级，已下载的安装包不会丢失',
          primary: '立即安装',
          primaryKind: 'install' as const,
          tone: GLASS.ok,
        }
      case 'error':
        return {
          title: '下载失败',
          subtitle: '可以重试一次，或稍后再来下载',
          primary: '重新下载',
          primaryKind: 'download' as const,
          tone: GLASS.warn,
        }
      case 'checking':
        return {
          title: '正在检查更新…',
          subtitle: '正在和云端比对版本号',
          primary: '检查中…',
          primaryKind: 'busy' as const,
          tone: GLASS.dim,
        }
      default:
        return {
          title: '发现新版本',
          subtitle: `v${remoteVersion} 已发布，当前 v${localVersion}`,
          primary: '立即更新',
          primaryKind: 'download' as const,
          tone: GLASS.warn,
        }
    }
  }, [forceUpdate, guard.minVersion, guard.latestVersion, versionInfo.isUnknown, versionInfo.isLatest, staleRemote, hasUpdate, status, downloading, downloaded, progress, percent, remoteVersion, localVersion])

  const handleCancel = useCallback(() => {
    // 强更模式没有「稍后再说」：点背景 / 返回键都不关
    if (forceUpdate) return
    hideModal(componentId)
  }, [componentId, forceUpdate])

  // 强更时吃掉系统返回键，避免 Navigation overlay 被 pop 掉
  useEffect(() => {
    if (!forceUpdate) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => { sub.remove() }
  }, [forceUpdate])

  const handleIgnore = useCallback(() => {
    setIgnoreVersion(ignoreVersion != versionInfo.newVersion?.version ? versionInfo.newVersion?.version ?? null : null)
  }, [ignoreVersion, versionInfo.newVersion?.version])

  const handlePrimary = useCallback(() => {
    switch (view.primaryKind) {
      case 'check':
        void checkUpdate()
        break
      case 'install':
        void updateApp()
        break
      case 'download':
        downloadUpdate()
        break
      case 'force':
        void openUrl(guard.downloadUrl || UPDATE_DOWNLOAD_URL).catch(() => {
          void openUrl(UPDATE_DOWNLOAD_URL)
        })
        break
      default:
        break
    }
  }, [view.primaryKind, guard.downloadUrl])

  const history = useMemo(() => {
    if (!versionInfo.newVersion?.history) return []
    return versionInfo.newVersion.history.filter(ver => compareVersion(localVersion, ver.version) < 0)
  }, [versionInfo.newVersion, localVersion])

  const desc = versionInfo.newVersion?.desc ?? ''
  const showIgnore = hasUpdate && !staleRemote && !downloaded && !downloading && !forceUpdate

  return (
    <View style={styles.root}>
      <Pressable style={styles.backdrop} onPress={handleCancel} />

      <View style={styles.card}>
        {/* 顶部光晕：深色毛玻璃上的那一层"光" */}
        <Gradient colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)']} steps={18} style={styles.glow} />

        <View style={styles.header}>
          <View style={styles.brandRow}>
            <Gradient colors={stops} direction="diagonal" style={styles.logo}>
              <Text style={styles.logoText}>Y</Text>
            </Gradient>
            <Text style={styles.brand}>Yieyu Music</Text>
            {localMeta.badge
              ? (
                  <View style={styles.badge}>
                    <View style={[styles.badgeDot, { backgroundColor: GLASS.ok }]} />
                    <Text style={styles.badgeText}>{localMeta.badge}</Text>
                  </View>
                )
              : null}
          </View>

          <Text style={styles.title}>{view.title}</Text>
          <View style={styles.subRow}>
            <StatusDot color={view.tone} />
            <Text style={styles.subtitle}>{view.subtitle}</Text>
          </View>
        </View>

        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Text style={styles.chipLabel}>本机</Text>
            <Text style={styles.chipValue}>v{localVersion}{localCode ? ` · ${localCode}` : ''}</Text>
          </View>
          {forceUpdate
            ? (
                <View style={[styles.chip, styles.chipMin]}>
                  <Text style={[styles.chipLabel, { color: GLASS.warn }]}>最低支持</Text>
                  <Text style={[styles.chipValue, { color: GLASS.warn }]}>v{guard.minVersion || '—'}</Text>
                </View>
              )
            : null}
          {showRemote
            ? (
                <View style={[styles.chip, styles.chipNew]}>
                  <Text style={[styles.chipLabel, { color: GLASS.ok }]}>最新</Text>
                  <Text style={[styles.chipValue, { color: GLASS.ok }]}>v{remoteVersion}</Text>
                </View>
              )
            : null}
          {remoteMeta.badge && !showRemote && !staleRemote
            ? (
                <View style={styles.chip}>
                  <Text style={styles.chipLabel}>云端</Text>
                  <Text style={styles.chipValue}>{remoteMeta.badge}</Text>
                </View>
              )
            : null}
        </View>

        {forceUpdate
          ? (
              <View style={styles.forceBar}>
                <Text style={styles.forceText}>
                  此窗口无法关闭、也不支持跳过：请先下载并覆盖安装最新版，更新后卡密与设备码不会变化。
                </Text>
              </View>
            )
          : null}

        {staleRemote
          ? (
              <View style={styles.tipBar}>
                <Text style={styles.tipText}>
                  云端元数据还停在 v{staleVersion}（CDN 缓存 / 仓库不可匿名读取），本机 v{localVersion} 更新，已按本机为准。
                </Text>
              </View>
            )
          : null}

        {downloading
          ? (
              <View style={styles.progressWrap}>
                <View style={styles.progressTrack}>
                  <Gradient colors={stops} direction="horizontal" steps={16} style={[styles.progressFill, { width: `${percent}%` }]} />
                </View>
                <Text style={styles.progressText}>{percent.toFixed(1)}%</Text>
              </View>
            )
          : null}

        <View style={styles.glass}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {desc ? <ChangeLog text={desc} /> : <Text style={styles.logPlain}>暂无更新说明</Text>}
            {history.length
              ? (
                  <View style={styles.history}>
                    <Text style={styles.sectionLabel}>历史版本</Text>
                    {history.map((item, index) => <HistoryItem key={index} version={item.version} desc={item.desc} />)}
                  </View>
                )
              : null}
          </ScrollView>
        </View>

        <View style={[styles.btns, forceUpdate ? styles.btnsForce : null]}>
          {showIgnore
            ? (
                <Pressable style={styles.ghost} onPress={handleIgnore}>
                  <Text style={styles.ghostText}>{ignoreVersion == versionInfo.newVersion?.version ? '取消忽略' : '忽略此版本'}</Text>
                </Pressable>
              )
            : null}
          {forceUpdate
            ? null
            : (
                <Pressable style={styles.ghost} onPress={handleCancel}>
                  <Text style={styles.ghostText}>{downloading ? '后台下载' : '稍后再说'}</Text>
                </Pressable>
              )}
          <Gradient
            colors={view.primaryKind === 'busy'
              ? ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.08)']
              : view.primaryKind === 'force'
                ? ['#FFB86B', '#FF7A59', '#E5484D']
                : stops}
            direction="diagonal"
            steps={20}
            style={[styles.primaryWrap, forceUpdate ? styles.primaryWrapForce : null]}
          >
            <Pressable style={styles.primary} onPress={handlePrimary} disabled={view.primaryKind === 'busy'}>
              <Text style={styles.primaryText}>{view.primary}</Text>
            </Pressable>
          </Gradient>
        </View>
      </View>
    </View>
  )
}

const styles = createStyle({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 18,
    paddingRight: 18,
  },
  backdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(4,6,10,0.74)',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '84%',
    borderRadius: 28,
    backgroundColor: GLASS.card,
    borderWidth: 1,
    borderColor: GLASS.panelBorder,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.55,
    shadowRadius: 36,
    elevation: 20,
  },
  glow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 150,
    backgroundColor: 'transparent',
  },
  header: {
    paddingTop: 20,
    paddingLeft: 20,
    paddingRight: 20,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logo: {
    width: 26,
    height: 26,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0B0E14',
  },
  brand: {
    flexGrow: 1,
    marginLeft: 9,
    fontSize: 13,
    letterSpacing: 0.4,
    color: GLASS.text,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 9,
    paddingRight: 9,
    borderRadius: 999,
    backgroundColor: GLASS.panel,
    borderWidth: 1,
    borderColor: GLASS.panelBorder,
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginRight: 5,
  },
  badgeText: {
    fontSize: 11,
    color: GLASS.text,
  },
  title: {
    marginTop: 14,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0.2,
    color: GLASS.title,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 7,
  },
  subtitle: {
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 17,
    color: GLASS.dim,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingTop: 14,
    paddingLeft: 20,
    paddingRight: 20,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 8,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 11,
    paddingRight: 11,
    borderRadius: 12,
    backgroundColor: GLASS.panel,
    borderWidth: 1,
    borderColor: GLASS.panelBorder,
  },
  chipNew: {
    backgroundColor: 'rgba(91,231,169,0.10)',
    borderColor: 'rgba(91,231,169,0.35)',
  },
  chipMin: {
    backgroundColor: 'rgba(255,196,107,0.09)',
    borderColor: 'rgba(255,196,107,0.30)',
  },
  chipLabel: {
    fontSize: 11,
    marginRight: 6,
    color: GLASS.dimmer,
  },
  chipValue: {
    fontSize: 12,
    fontWeight: '600',
    color: GLASS.text,
  },
  tipBar: {
    marginLeft: 20,
    marginRight: 20,
    marginBottom: 10,
    paddingTop: 9,
    paddingBottom: 9,
    paddingLeft: 11,
    paddingRight: 11,
    borderRadius: 12,
    backgroundColor: 'rgba(255,196,107,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,196,107,0.28)',
  },
  tipText: {
    fontSize: 11,
    lineHeight: 16,
    color: GLASS.warn,
  },
  forceBar: {
    marginLeft: 20,
    marginRight: 20,
    marginBottom: 10,
    paddingTop: 9,
    paddingBottom: 9,
    paddingLeft: 11,
    paddingRight: 11,
    borderRadius: 12,
    backgroundColor: 'rgba(255,143,163,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,143,163,0.26)',
  },
  forceText: {
    fontSize: 11,
    lineHeight: 16,
    color: GLASS.danger,
  },
  progressWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 20,
    marginRight: 20,
    marginBottom: 10,
  },
  progressTrack: {
    flex: 1,
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  progressFill: {
    height: 6,
    borderRadius: 999,
  },
  progressText: {
    marginLeft: 10,
    fontSize: 11,
    color: GLASS.dim,
  },
  glass: {
    marginLeft: 16,
    marginRight: 16,
    marginBottom: 4,
    borderRadius: 18,
    backgroundColor: GLASS.panel,
    borderWidth: 1,
    borderColor: GLASS.panelBorder,
    overflow: 'hidden',
  },
  scroll: {
    maxHeight: 250,
  },
  scrollContent: {
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 14,
    paddingRight: 14,
  },
  logLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 7,
  },
  logDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 7,
    marginRight: 8,
    backgroundColor: 'rgba(91,231,169,0.75)',
  },
  logText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 19,
    color: GLASS.text,
  },
  logHead: {
    fontSize: 14,
    fontWeight: '700',
    color: GLASS.title,
    marginBottom: 4,
  },
  logPlain: {
    fontSize: 12,
    lineHeight: 19,
    color: GLASS.dim,
  },
  sectionLabel: {
    marginTop: 6,
    marginBottom: 8,
    fontSize: 11,
    letterSpacing: 1,
    color: GLASS.dimmer,
  },
  history: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: GLASS.line,
    paddingTop: 12,
  },
  historyItem: {
    marginBottom: 12,
  },
  historyHead: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  historyVer: {
    fontSize: 12,
    fontWeight: '700',
    color: GLASS.dim,
  },
  historyDesc: {
    fontSize: 11,
    lineHeight: 17,
    color: GLASS.dimmer,
  },
  btns: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingTop: 12,
    paddingBottom: 16,
    paddingLeft: 16,
    paddingRight: 16,
  },
  btnsForce: {
    paddingTop: 14,
    paddingBottom: 18,
  },
  ghost: {
    paddingTop: 11,
    paddingBottom: 11,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 14,
    marginRight: 6,
  },
  ghostText: {
    fontSize: 13,
    color: GLASS.dim,
  },
  primaryWrap: {
    flexGrow: 1,
    maxWidth: 170,
    borderRadius: 16,
  },
  primaryWrapForce: {
    maxWidth: '100%',
  },
  primary: {
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 16,
    paddingRight: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#08110C',
  },
})

export default VersionModal
