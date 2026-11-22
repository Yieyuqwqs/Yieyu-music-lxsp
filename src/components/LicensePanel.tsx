import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Modal, ScrollView, TouchableOpacity, View, StyleSheet } from 'react-native'

import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import Input from '@/components/common/Input'
import { useLicenseInfo, isProInfo, vipStatusText } from '@/store/license/hook'
import { activateLicense, clearLicense, getDeviceCode } from '@/core/license'
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
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { void getDeviceCode() }, [])

  // 状态文案与到期行（之前在清理黑名单代码时被误删，导致 PanelContent 报 statusText is not defined）
  const statusText = useMemo(() => vipStatusText(info), [info])
  const expireLine = useMemo(() => info.record?.expiresAt ? `到期时间：${info.record.expiresAt.slice(0, 10)}` : '', [info.record])

  const handleCopyDevice = useCallback(() => {
    clipboardWriteText(info.deviceCode)
    toast('设备码已复制，发给管理员即可获取卡密')
  }, [info.deviceCode])

  const handleActivate = useCallback(() => {
    if (busy) return
    setBusy(true)
    void activateLicense(code)
      .then(res => {
        if (res.ok) {
          toast(res.message, 'long')
          setCode('')
        } else {
          Alert.alert('激活失败', res.message)
        }
      })
      .catch((err: Error) => { Alert.alert('激活失败', err.message || '未知错误') })
      .finally(() => setBusy(false))
  }, [busy, code])

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
          <Text style={styles.hint}>点击复制。设备码只在本机生成，不上传任何服务器；换机或清除数据后会变。</Text>
        </View>

        <View style={styles.block}>
          <Text style={styles.label}>授权状态</Text>
          <Text style={[styles.status, { color: pro ? '#2ecc71' : '#ff5c7a', fontWeight: '700' }]}>{statusText}</Text>
          {expireLine ? <Text style={styles.hint}>{expireLine}</Text> : null}
          {info.record?.cardMasked ? <Text style={styles.hint}>当前卡密：{info.record.cardMasked}</Text> : null}
        </View>

        <View style={styles.block}>
          <Text style={styles.label}>输入授权码</Text>
          <Input
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="YIEYU-XXXX-XXXXX（16 位）"
            autoCapitalize="characters"
            autoCorrect={false}
            multiline
          />
          <View style={styles.row}>
            <Button style={styles.btnPrimary} onPress={handleActivate}>
              <Text color="#fff">{busy ? '校验中…' : '立即激活'}</Text>
            </Button>
            {pro
              ? (
                <Button style={styles.btn} onPress={() => {
                  void clearLicense().then(() => { toast('已解除本机授权') })
                }}>
                  <Text>解除授权</Text>
                </Button>
              )
              : null}
          </View>
          <Text style={styles.hint}>
            卡密由管理员生成、绑定本机设备码，本机离线校验，断网也能激活。
          </Text>
        </View>

        <View style={styles.block}>
          <Text style={styles.hint}>激活后解锁：蝰蛇空间音效、播放页频谱可视化等会员功能。</Text>
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
  input: {
    marginBottom: 8,
    minHeight: 60,
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
