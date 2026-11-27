import { memo, useCallback, useEffect, useMemo } from 'react'
import { BackHandler, Modal, Pressable, View } from 'react-native'

import Text from '@/components/common/Text'
import Gradient from '@/components/common/Gradient'
import { useGuardInfo } from '@/store/guard/hook'
import { createStyle, openUrl } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { UPDATE_DOWNLOAD_URL } from '@/config/updateGuard'

/** 与版本弹窗同一套深色玻璃语言：强制更新是它的"死锁"形态，不是另一套 UI */
const GLASS = {
  card: 'rgba(17,19,27,0.96)',
  panel: 'rgba(255,255,255,0.055)',
  panelBorder: 'rgba(255,255,255,0.10)',
  title: '#F4F6FA',
  text: 'rgba(233,238,247,0.88)',
  dim: 'rgba(203,213,225,0.58)',
  dimmer: 'rgba(203,213,225,0.40)',
  warn: '#FFC46B',
  danger: '#FF8FA3',
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

const accentStops = (primary?: string): string[] => {
  const [r, g, b] = parseRgb(primary)
  return [
    `rgb(${clamp255(r + 46)}, ${clamp255(g + 38)}, ${clamp255(b + 52)})`,
    `rgb(${r}, ${g}, ${b})`,
    `rgb(${clamp255(r * 0.72)}, ${clamp255(g * 0.72)}, ${clamp255(b * 0.82)})`,
  ]
}

const FALLBACK_VERSION = typeof process.versions?.app === 'string' ? process.versions.app : ''

/**
 * 强制更新拦截层：
 * - 只有「当前版本 < 云端最低支持版本」时显示（guard.status === 'blocked'）
 * - 全屏不可关闭：没有取消按钮、没有背景点击、返回键被吃掉，Modal 的 onRequestClose 也是空操作
 * - 唯一出口是「立即下载」，跳到云端指定的下载页
 */
export default memo(() => {
  const guard = useGuardInfo()
  const theme = useTheme()
  const visible = guard.status === 'blocked'

  const handleUpdate = useCallback(() => {
    void openUrl(guard.downloadUrl || UPDATE_DOWNLOAD_URL).catch(() => {
      void openUrl(UPDATE_DOWNLOAD_URL)
    })
  }, [guard.downloadUrl])

  // 返回键无效：这个弹窗是唯一出口，点背景也没有任何绑定的 onPress
  useEffect(() => {
    if (!visible) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => { sub.remove() }
  }, [visible])

  const stops = useMemo(() => accentStops(theme['c-primary']), [theme])
  const localCodeText = guard.localCode ? `（code ${guard.localCode}）` : ''

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={() => {}}
      statusBarTranslucent
      hardwareAccelerated
    >
      <View style={styles.mask}>
        <View style={styles.card}>
          <Gradient colors={['rgba(255,196,107,0.16)', 'rgba(255,196,107,0.02)', 'rgba(255,196,107,0)']} steps={18} style={styles.glow} />

          <View style={styles.header}>
            <View style={styles.brandRow}>
              <Gradient colors={stops} direction="diagonal" style={styles.logo}>
                <Text style={styles.logoText}>Y</Text>
              </Gradient>
              <Text style={styles.brand}>Yieyu Music</Text>
              <View style={styles.lockTag}>
                <View style={styles.lockDot} />
                <Text style={styles.lockText}>强制更新</Text>
              </View>
            </View>

            <Text style={styles.title}>必须更新才能继续</Text>
            <View style={styles.subRow}>
              <View style={styles.subDot} />
              <Text style={styles.subtitle}>当前版本已低于云端最低支持版本，旧版接口已停止服务</Text>
            </View>
          </View>

          <View style={styles.chipRow}>
            <View style={styles.chip}>
              <Text style={styles.chipLabel}>本机</Text>
              <Text style={styles.chipValue}>v{guard.localVersion || FALLBACK_VERSION}{localCodeText}</Text>
            </View>
            <View style={[styles.chip, styles.chipDanger]}>
              <Text style={[styles.chipLabel, { color: GLASS.warn }]}>最低支持</Text>
              <Text style={[styles.chipValue, { color: GLASS.warn }]}>v{guard.minVersion || '—'}</Text>
            </View>
            {guard.latestVersion
              ? (
                  <View style={[styles.chip, styles.chipOk]}>
                    <Text style={[styles.chipLabel, { color: GLASS.ok }]}>最新</Text>
                    <Text style={[styles.chipValue, { color: GLASS.ok }]}>v{guard.latestVersion}</Text>
                  </View>
                )
              : null}
          </View>

          <View style={styles.glass}>
            <Text style={styles.sectionLabel}>更新说明</Text>
            <Text style={styles.body}>
              {guard.message || '授权方式升级：旧的卡密全部作废。更新后请把「设备码」发给管理员开通，再绑定本机指纹。'}
            </Text>
            <View style={styles.divider} />
            <View style={styles.noticeRow}>
              <Text style={styles.noticeIcon}>!</Text>
              <Text style={styles.noticeText}>此窗口无法关闭，也不支持跳过；请下载并覆盖安装最新版后继续使用。</Text>
            </View>
          </View>

          <Gradient colors={['#FFB86B', '#FF7A59', '#E5484D']} direction="diagonal" steps={22} style={styles.primaryWrap}>
            <Pressable style={styles.primary} onPress={handleUpdate}>
              <Text style={styles.primaryText}>立即下载{guard.latestVersion ? ` v${guard.latestVersion}` : '最新版'}</Text>
            </Pressable>
          </Gradient>

          <Text style={styles.footer}>设备码不变 · 旧卡密作废，需重新开通并绑定指纹</Text>
        </View>
      </View>
    </Modal>
  )
})

const styles = createStyle({
  mask: {
    flex: 1,
    backgroundColor: '#07090D',
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 18,
    paddingRight: 18,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 28,
    backgroundColor: GLASS.card,
    borderWidth: 1,
    borderColor: GLASS.panelBorder,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.6,
    shadowRadius: 36,
    elevation: 24,
    paddingBottom: 18,
  },
  glow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 170,
    backgroundColor: 'transparent',
  },
  header: {
    paddingTop: 22,
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
  lockTag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 9,
    paddingRight: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(255,143,163,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,143,163,0.26)',
  },
  lockDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginRight: 5,
    backgroundColor: GLASS.danger,
  },
  lockText: {
    fontSize: 11,
    letterSpacing: 0.2,
    color: GLASS.danger,
  },
  title: {
    marginTop: 16,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0.2,
    color: GLASS.title,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  subDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 7,
    backgroundColor: GLASS.warn,
  },
  subtitle: {
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 18,
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
    minWidth: 92,
    marginRight: 8,
    marginBottom: 8,
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 11,
    paddingRight: 11,
    borderRadius: 12,
    backgroundColor: GLASS.panel,
    borderWidth: 1,
    borderColor: GLASS.panelBorder,
  },
  chipDanger: {
    backgroundColor: 'rgba(255,196,107,0.08)',
    borderColor: 'rgba(255,196,107,0.22)',
  },
  chipOk: {
    backgroundColor: 'rgba(91,231,169,0.07)',
    borderColor: 'rgba(91,231,169,0.20)',
  },
  chipLabel: {
    fontSize: 10,
    letterSpacing: 0.6,
    color: GLASS.dimmer,
  },
  chipValue: {
    marginTop: 2,
    fontSize: 12,
    color: GLASS.text,
  },
  glass: {
    marginTop: 4,
    marginLeft: 20,
    marginRight: 20,
    paddingTop: 13,
    paddingBottom: 13,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 16,
    backgroundColor: GLASS.panel,
    borderWidth: 1,
    borderColor: GLASS.panelBorder,
  },
  sectionLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
    color: GLASS.dimmer,
  },
  body: {
    marginTop: 7,
    fontSize: 13,
    lineHeight: 21,
    color: GLASS.text,
  },
  divider: {
    marginTop: 11,
    marginBottom: 11,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  noticeIcon: {
    width: 16,
    height: 16,
    marginRight: 7,
    marginTop: 1,
    borderRadius: 8,
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    color: '#0B0E14',
    backgroundColor: GLASS.warn,
  },
  noticeText: {
    flex: 1,
    flexShrink: 1,
    fontSize: 11,
    lineHeight: 17,
    color: GLASS.dim,
  },
  primaryWrap: {
    marginTop: 16,
    marginLeft: 20,
    marginRight: 20,
    borderRadius: 999,
  },
  primary: {
    minHeight: 50,
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 18,
    paddingRight: 18,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
    color: '#1A0D0A',
  },
  footer: {
    marginTop: 12,
    paddingLeft: 20,
    paddingRight: 20,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    color: GLASS.dimmer,
  },
})
