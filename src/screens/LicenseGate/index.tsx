import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Animated, Easing, ScrollView, TouchableOpacity, View } from 'react-native'

import Text from '@/components/common/Text'
import Input from '@/components/common/Input'
import Button from '@/components/common/Button'
import ForceUpdateModal from '@/components/ForceUpdateModal'
import {
  applyAuthString, bindByWhitelist, getDeviceCode, recheckBiometric, refreshAuthorization, unlockWithFingerprint,
} from '@/core/license'
import licenseState from '@/store/license/state'
import { useLicenseInfo, vipStatusText } from '@/store/license/hook'
import { toast, clipboardWriteText } from '@/utils/tools'
import { navigations } from '@/navigation'

const BAR_COUNT = 40

/** 一条会呼吸的频谱柱 */
const SpectrumBar = ({ index }: { index: number }) => {
  const value = useRef(new Animated.Value(0.15)).current
  useEffect(() => {
    const durations = [520, 680, 440, 760, 600]
    const delay = (index % 7) * 60
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(value, { toValue: 0.35 + ((index * 37) % 60) / 100, duration: durations[index % durations.length], easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(value, { toValue: 0.12 + ((index * 13) % 25) / 100, duration: durations[(index + 2) % durations.length], easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [index, value])

  return (
    <Animated.View
      style={{
        flex: 1,
        marginHorizontal: 1.5,
        height: 120,
        borderRadius: 3,
        backgroundColor: index % 3 === 0 ? '#ff4d6d' : index % 3 === 1 ? '#7c5cff' : '#3b9cff',
        opacity: 0.55,
        transform: [{ scaleY: value }],
      }}
    />
  )
}

/** 漂浮光斑 */
const Aurora = ({ color, size, from, to, duration, delay }: {
  color: string, size: number, from: { x: number, y: number }, to: { x: number, y: number }, duration: number, delay: number
}) => {
  const progress = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration, delay, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(progress, { toValue: 0, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [duration, delay, progress])

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        opacity: 0.16,
        transform: [
          { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [from.x, to.x] }) },
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [from.y, to.y] }) },
        ],
      }}
    />
  )
}

const enterHome = async() => {
  await navigations.pushHomeScreen()
}

export default memo(({ componentId }: { componentId: string }) => {
  const info = useLicenseInfo()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const autoTried = useRef(false)

  useEffect(() => { void getDeviceCode() }, [])

  const status = info.status
  const statusLine = useMemo(() => vipStatusText(info), [info])
  const unlocked = status === 'active'
  const needBind = status === 'ready'
  const needUnlock = status === 'locked'

  const toHome = useCallback(async() => {
    await navigations.pushHomeScreen()
  }, [])

  /** 统一执行：失败弹窗、成功 toast，after 里决定要不要进主界面 */
  const exec = useCallback(async(
    task: () => Promise<{ ok: boolean, message: string }>,
    after?: () => Promise<void> | void,
  ) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await task()
      if (!res.ok) {
        Alert.alert('授权提示', res.message)
        return
      }
      toast(res.message, 'long')
      if (after) await after()
    } catch (error) {
      Alert.alert('授权失败', (error as Error)?.message ?? '未知错误')
    } finally {
      setBusy(false)
    }
  }, [busy])

  const enterIfActive = useCallback(async() => {
    if (licenseState.status === 'active') await toHome()
  }, [toHome])

  const handleCopy = useCallback(() => {
    if (!info.deviceCode) return
    clipboardWriteText(info.deviceCode)
    toast('设备码已复制，发给管理员开通')
  }, [info.deviceCode])

  const handlePrimary = useCallback(() => {
    if (needUnlock) {
      void exec(unlockWithFingerprint, enterIfActive)
      return
    }
    if (needBind) {
      void exec(bindByWhitelist, enterIfActive)
      return
    }
    if (status === 'no_biometric') {
      void exec(recheckBiometric)
      return
    }
    void exec(refreshAuthorization)
  }, [enterIfActive, exec, needBind, needUnlock, status])

  const handleImport = useCallback(() => {
    const text = code.trim()
    if (!text) {
      Alert.alert('提示', '请粘贴迁移码或离线授权串')
      return
    }
    void exec(async() => {
      const res = await applyAuthString(text)
      if (res.ok) setCode('')
      return res
    }, enterIfActive)
  }, [code, enterIfActive, exec])

  // 联网后发现自己刚被管理员授权：直接弹指纹（「管理员填完设备码他就能用」）
  useEffect(() => {
    if (status !== 'ready' || autoTried.current) return
    autoTried.current = true
    void exec(bindByWhitelist, enterIfActive)
  }, [enterIfActive, exec, status])

  const primaryLabel = useMemo(() => {
    if (busy) return '处理中…'
    if (needUnlock) return '按指纹进入'
    if (needBind) return '绑定本机指纹'
    if (status === 'no_biometric') return '重新检查指纹'
    return '刷新授权状态'
  }, [busy, needBind, needUnlock, status])

  return (
    <View style={{ flex: 1, backgroundColor: '#08090c' }}>
      <ForceUpdateModal />

      {/* 背景：光斑 + 频谱 */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
        <Aurora color="#ff4d6d" size={320} from={{ x: -120, y: -60 }} to={{ x: 60, y: 40 }} duration={7200} delay={0} />
        <Aurora color="#7c5cff" size={380} from={{ x: 200, y: 120 }} to={{ x: 120, y: 20 }} duration={9000} delay={400} />
        <Aurora color="#3b9cff" size={300} from={{ x: -60, y: 460 }} to={{ x: 40, y: 380 }} duration={8000} delay={800} />
        <View style={{ position: 'absolute', left: 24, right: 24, bottom: 40, flexDirection: 'row', alignItems: 'flex-end', height: 120 }}>
          {Array.from({ length: BAR_COUNT }).map((_, i) => <SpectrumBar key={i} index={i} />)}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 60 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: '#fff', fontSize: 30, fontWeight: '800', letterSpacing: 1 }}>Yieyu Music</Text>
        <Text style={{ color: '#8b93a1', fontSize: 13, marginTop: 6, letterSpacing: 2 }}>DEVICE LICENSE · FINGERPRINT</Text>

        <View style={{ marginTop: 26, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', padding: 18 }}>
          <Text style={{ color: '#8b93a1', fontSize: 12 }}>授权状态</Text>
          <Text style={{ color: unlocked ? '#7ee787' : '#ff8fa3', fontSize: 18, fontWeight: '700', marginTop: 4 }}>{statusLine}</Text>
          {info.message
            ? <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 8, lineHeight: 18 }}>{info.message}</Text>
            : null}

          <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 18 }}>本机设备码（发给管理员）</Text>
          <TouchableOpacity onPress={handleCopy}>
            <Text style={{ color: '#7ee0ff', fontSize: 19, fontWeight: '700', letterSpacing: 1.4, marginTop: 6 }}>
              {info.deviceCode || '生成中…'}
            </Text>
          </TouchableOpacity>
          <Text style={{ color: '#5a6270', fontSize: 11, marginTop: 6 }}>
            点击复制 · 硬件派生：重装/清数据不变，换手机才变
          </Text>

          <View style={{ marginTop: 18 }}>
            <Button
              onPress={handlePrimary}
              style={{ backgroundColor: busy ? '#2b303b' : '#ff4d6d', borderRadius: 10, paddingVertical: 13, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>{primaryLabel}</Text>
            </Button>
          </View>

          {!needBind && !needUnlock
            ? (
              <TouchableOpacity onPress={() => { void exec(refreshAuthorization) }} style={{ marginTop: 12, alignItems: 'center' }}>
                <Text style={{ color: '#7c9cff', fontSize: 13 }}>{busy ? '刷新中…' : '管理员已开通？点这里刷新云端授权'}</Text>
              </TouchableOpacity>
            )
            : null}
        </View>

        <TouchableOpacity onPress={() => setShowImport(v => !v)} style={{ marginTop: 18, alignItems: 'center' }}>
          <Text style={{ color: '#8b93a1', fontSize: 12 }}>{showImport ? '收起' : '换手机 / 没网？用迁移码或离线授权串'}</Text>
        </TouchableOpacity>

        {showImport
          ? (
            <View style={{ marginTop: 12, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', padding: 14 }}>
              <Text style={{ color: '#8b93a1', fontSize: 12 }}>
                迁移码以 YMG1 开头（老设备「授权中心」导出，24 小时有效）；离线授权串以 YEYA 开头（管理员签发）
              </Text>
              <View style={{ backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 10, paddingHorizontal: 10, marginTop: 8 }}>
                <Input
                  value={code}
                  onChangeText={setCode}
                  placeholder="粘贴迁移码 / 离线授权串"
                  placeholderTextColor="#4b5563"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  multiline
                  style={{ color: '#e5e7eb', minHeight: 64, fontSize: 12 }}
                />
              </View>
              <View style={{ marginTop: 12 }}>
                <Button
                  onPress={handleImport}
                  style={{ backgroundColor: busy ? '#2b303b' : '#3b9cff', borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}
                >
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{busy ? '校验中…' : '导入并绑定指纹'}</Text>
                </Button>
              </View>
            </View>
          )
          : null}

        <Text style={{ color: '#4b5563', fontSize: 11, lineHeight: 18, marginTop: 18, textAlign: 'center' }}>
          卡密体系已废除：旧的 16 位卡密全部作废，请把上面的设备码发给管理员重新开通。{'\n'}
          锁屏或重开 App 都要重新验证一次指纹。
        </Text>
      </ScrollView>
    </View>
  )
})
