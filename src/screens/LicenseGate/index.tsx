import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Animated, Easing, ScrollView, TouchableOpacity, View } from 'react-native'

import Text from '@/components/common/Text'
import Input from '@/components/common/Input'
import Button from '@/components/common/Button'
import ForceUpdateModal from '@/components/ForceUpdateModal'
import { activateLicense, getDeviceCode } from '@/core/license'
import { useLicenseInfo, vipStatusText } from '@/store/license/hook'
import { useGuardInfo } from '@/store/guard/hook'
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

export default memo(({ componentId }: { componentId: string }) => {
  const info = useLicenseInfo()
  const guard = useGuardInfo()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const offline = guard.status === 'offline'

  useEffect(() => { void getDeviceCode() }, [])

  const handleCopy = useCallback(() => {
    clipboardWriteText(info.deviceCode)
    toast('设备码已复制')
  }, [info.deviceCode])

  const handleActivate = useCallback(() => {
    if (busy) return
    setBusy(true)
    void activateLicense(code)
      .then(async(res) => {
        if (res.ok) {
          toast(res.message, 'long')
          setCode('')
          await navigations.pushHomeScreen()
        } else {
          Alert.alert('激活失败', res.message)
        }
      })
      .catch((err: Error) => { Alert.alert('激活失败', err.message || '未知错误') })
      .finally(() => setBusy(false))
  }, [busy, code])

  const statusText = useMemo(() => vipStatusText(info), [info])

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
        <Text style={{ color: '#8b93a1', fontSize: 13, marginTop: 6, letterSpacing: 2 }}>MEMBERSHIP LICENSE</Text>

        <View style={{ marginTop: 26, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', padding: 18 }}>
          <Text style={{ color: '#8b93a1', fontSize: 12 }}>授权状态</Text>
          <Text style={{ color: info.status === 'active' ? '#7ee787' : '#ff8fa3', fontSize: 18, fontWeight: '700', marginTop: 4 }}>{statusText}</Text>
          {info.status === 'expired'
            ? <Text style={{ color: '#ff8fa3', fontSize: 12, marginTop: 8, lineHeight: 18 }}>您的授权已到期，请联系管理员续期后再激活。</Text>
            : null}
          {info.status === 'tampered'
            ? <Text style={{ color: '#e3b341', fontSize: 12, marginTop: 8, lineHeight: 18 }}>检测到系统时间被调回，请把手机时间设为自动校准后重试。</Text>
            : null}

          <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 18 }}>本机设备码（发给管理员）</Text>
          <TouchableOpacity onPress={handleCopy}>
            <Text style={{ color: '#7ee0ff', fontSize: 19, fontWeight: '700', letterSpacing: 1.4, marginTop: 6 }}>
              {info.deviceCode || '生成中…'}
            </Text>
          </TouchableOpacity>
          <Text style={{ color: '#5a6270', fontSize: 11, marginTop: 6 }}>点击复制 · 换机或清除数据后设备码会变</Text>

          {offline && info.status !== 'active'
            ? (
              <Text style={{ color: '#e3b341', fontSize: 12, marginTop: 12, lineHeight: 18 }}>
                已持有卡密可直接在下方粘贴激活（本机离线校验，16 位短卡密）。
              </Text>
            )
            : null}

          <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 18 }}>授权码</Text>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 10, paddingHorizontal: 10, marginTop: 6 }}>
            <Input
              value={code}
              onChangeText={setCode}
              placeholder="粘贴卡密，例如 YIEYU-XXXX-XXXXX"
              placeholderTextColor="#4b5563"
              autoCapitalize="characters"
              autoCorrect={false}
              multiline
              style={{ color: '#e5e7eb', minHeight: 64, fontSize: 12 }}
            />
          </View>

          <View style={{ marginTop: 16 }}>
            <Button
              onPress={handleActivate}
              style={{ backgroundColor: busy ? '#2b303b' : '#ff4d6d', borderRadius: 10, paddingVertical: 13, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>{busy ? '校验中…' : '激活并进入'}</Text>
            </Button>
          </View>
        </View>

        <Text style={{ color: '#4b5563', fontSize: 11, lineHeight: 18, marginTop: 18, textAlign: 'center' }}>
          未激活无法进入主界面。「设置 → 关于 → 授权」仅在激活后可见。
        </Text>
      </ScrollView>
    </View>
  )
})
