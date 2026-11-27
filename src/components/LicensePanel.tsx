import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Modal, ScrollView, TouchableOpacity, View, StyleSheet } from 'react-native'

import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { useLicenseInfo, isProInfo, vipStatusText } from '@/store/license/hook'
import {
  bindByWhitelist, clearLocalLicense, exportMigrationCode, getDeviceCode, lockNow, refreshAuthorization,
  unlockWithFingerprint,
} from '@/core/license'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast, clipboardWriteText } from '@/utils/tools'

interface Props {
  visible: boolean
  onClose: () => void
}

const PanelContent = ({ onClose }: Omit<Props, 'visible'>) => {
  const theme = useTheme()
  const info = useLicenseInfo()
  const pro = isProInfo(info)
  const [busy, setBusy] = useState(false)
  const [migration, setMigration] = useState('')

  useEffect(() => { void getDeviceCode() }, [])

  const statusText = useMemo(() => vipStatusText(info), [info])
  const expireLine = useMemo(() => {
    if (info.status !== 'active' && info.status !== 'locked') return ''
    return info.exp ? `到期时间：${info.exp.slice(0, 10)}` : '永久有效'
  }, [info.exp, info.status])

  const handleCopyDevice = useCallback(() => {
    if (!info.deviceCode) return
    clipboardWriteText(info.deviceCode)
    toast('设备码已复制，发给管理员开通')
  }, [info.deviceCode])

  const exec = useCallback(async(task: () => Promise<{ ok: boolean, message: string }>, onOk?: () => void) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await task()
      if (!res.ok) {
        Alert.alert('授权提示', res.message)
        return
      }
      toast(res.message, 'long')
      onOk?.()
    } catch (error) {
      Alert.alert('授权失败', (error as Error)?.message ?? '未知错误')
    } finally {
      setBusy(false)
    }
  }, [busy])

  const handleVerify = useCallback(() => { void exec(unlockWithFingerprint) }, [exec])
  const handleBind = useCallback(() => { void exec(bindByWhitelist) }, [exec])
  const handleRefresh = useCallback(() => { void exec(refreshAuthorization) }, [exec])

  const handleExport = useCallback(() => {
    void exec(async() => {
      const res = await exportMigrationCode()
      if (res.ok && res.code) setMigration(res.code)
      return res
    })
  }, [exec])

  const handleCopyMigration = useCallback(() => {
    if (!migration) return
    clipboardWriteText(migration)
    toast('迁移码已复制（24 小时内有效，用一次即失效）', 'long')
  }, [migration])

  const handleClear = useCallback(() => {
    Alert.alert('解除本机授权', '解绑后需要重新找管理员开通（换机后可让管理员把云端条目换成新设备）。', [
      { text: '取消', style: 'cancel' },
      {
        text: '解除',
        style: 'destructive',
        onPress: () => {
          void clearLocalLicense().then(() => {
            setMigration('')
            toast('已解除本机授权')
          })
        },
      },
    ])
  }, [])

  const handleLock = useCallback(() => {
    void lockNow().then(() => { toast('已锁定，下次进入需要指纹') })
  }, [])

  const primary = useMemo(() => {
    if (info.status === 'locked') return { label: busy ? '验证中…' : '验证指纹进入', onPress: handleVerify }
    if (info.status === 'ready') return { label: busy ? '绑定中…' : '绑定本机指纹', onPress: handleBind }
    return { label: busy ? '刷新中…' : '刷新云端授权', onPress: handleRefresh }
  }, [busy, handleBind, handleRefresh, handleVerify, info.status])

  return (
    <View style={{ ...styles.container, backgroundColor: theme['c-content-background'] }}>
      <View style={styles.header}>
        <Text style={styles.title}>授权中心</Text>
        <TouchableOpacity onPress={onClose} style={styles.close}>
          <Text size={20} color={theme['c-font-label']}>×</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps={'always'}>
        <View style={styles.block}>
          <Text style={styles.label}>本机设备码（发给管理员）</Text>
          <TouchableOpacity onPress={handleCopyDevice}>
            <Text style={styles.deviceCode}>{info.deviceCode || '生成中…'}</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>点击复制。设备码由硬件派生：重装/清数据不变，换手机才变。</Text>
        </View>

        <View style={styles.block}>
          <Text style={styles.label}>授权状态</Text>
          <Text style={[styles.status, { color: pro ? '#2ecc71' : '#ff5c7a', fontWeight: '700' }]}>{statusText}</Text>
          {expireLine ? <Text style={styles.hint}>{expireLine}</Text> : null}
          {info.message ? <Text style={styles.hint}>{info.message}</Text> : null}
          <Text style={styles.hint}>
            已解锁：{pro ? '是' : '否'} · 云名单：{info.cloudOnline ? '已同步' : '用缓存'} · 指纹：{info.biometricAvailable ? '可用' : '不可用'}
          </Text>
        </View>

        <View style={styles.block}>
          <Button style={styles.btnPrimary} onPress={primary.onPress}>
            <Text color="#fff">{primary.label}</Text>
          </Button>
        </View>

        <View style={styles.block}>
          <Text style={styles.label}>换手机</Text>
          <View style={styles.row}>
            <Button style={styles.btn} onPress={handleExport}>
              <Text>导出迁移码</Text>
            </Button>
            <Button style={styles.btn} onPress={handleClear}>
              <Text>解除本机授权</Text>
            </Button>
            <Button style={styles.btn} onPress={handleLock}>
              <Text>立即锁定</Text>
            </Button>
          </View>
          {migration
            ? (
              <TouchableOpacity onPress={handleCopyMigration}>
                <Text style={styles.migrationCode}>{migration}</Text>
                <Text style={styles.hint}>点上面的码复制。24 小时内有效，用一次即失效；新手机在授权页「换手机/没网」里粘贴即可。</Text>
              </TouchableOpacity>
            )
            : null}
        </View>

        <View style={styles.block}>
          <Text style={styles.hint}>
            卡密已废除：旧的 16 位卡密全部作废，现在只认「设备码 + 本机指纹」。
            {'\n'}锁屏、重开 App 都要重新验证一次指纹；令牌用 Android Keystore 加密，拷到别的手机解不开。
          </Text>
        </View>
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  )
}

export default memo(({ visible, onClose }: Props) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.mask}>
      <PanelContent onClose={onClose} />
    </View>
  </Modal>
))

const styles = createStyle({
  mask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    width: '92%',
    maxHeight: '86%',
    borderRadius: 10,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  close: {
    position: 'absolute',
    right: 12,
  },
  scroll: {
    paddingHorizontal: 14,
  },
  block: {
    marginTop: 14,
  },
  label: {
    fontSize: 13,
    opacity: 0.6,
    marginBottom: 6,
  },
  deviceCode: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 1,
  },
  status: {
    fontSize: 15,
  },
  hint: {
    fontSize: 12,
    opacity: 0.5,
    marginTop: 6,
    lineHeight: 18,
  },
  migrationCode: {
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
    fontFamily: 'monospace' as const,
    color: '#3b9cff',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.5)',
    marginRight: 8,
    marginBottom: 8,
  },
  btnPrimary: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#3b9cff',
    marginRight: 8,
    marginBottom: 8,
  },
})
