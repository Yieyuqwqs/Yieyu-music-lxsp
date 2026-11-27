import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Animated, Easing, Image, ScrollView, TouchableOpacity, View } from 'react-native'

import Text from '@/components/common/Text'
import Input from '@/components/common/Input'
import Button from '@/components/common/Button'
import ForceUpdateModal from '@/components/ForceUpdateModal'
import {
  applyAuthString, bindByWhitelist, buildRequestCode, getDeviceCode, recheckBiometric, refreshAuthorization,
  unlockWithFingerprint,
} from '@/core/license'
import { avatarUrlOf, lookupQQ, type QQProfile } from '@/utils/qqProfile'
import licenseState from '@/store/license/state'
import { useLicenseInfo, vipStatusText } from '@/store/license/hook'
import { isValidQQ, normalizeQQ } from '@/core/authz/protocol'
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
  const [qq, setQQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState<QQProfile | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [requestCode, setRequestCode] = useState('')
  const [showImport, setShowImport] = useState(false)
  const autoTried = useRef(false)

  useEffect(() => { void getDeviceCode() }, [])

  const status = info.status
  const statusLine = useMemo(() => vipStatusText(info), [info])
  const unlocked = status === 'active'
  const needBind = status === 'ready'
  const needUnlock = status === 'locked'

  /** 拉头像/昵称：头像稳定，昵称大概率拿不到（腾讯要登录），拿不到也让管理员人工核对 */
  const handleLookupQQ = useCallback(() => {
    const value = normalizeQQ(qq)
    if (!isValidQQ(value)) {
      Alert.alert('请填写 QQ', 'QQ 号是 5~12 位数字。')
      return
    }
    setProfileBusy(true)
    setRequestCode('')
    setConfirmed(false)
    void lookupQQ(value)
      .then(result => {
        setProfile(result)
        if (!result.nickname) toast('已取到头像；昵称接口需要腾讯登录态，交给管理员人工审核', 'long')
      })
      .catch((error: Error) => {
        Alert.alert('QQ 资料获取失败', error?.message ?? '网络异常，请稍后重试')
      })
      .finally(() => setProfileBusy(false))
  }, [qq])

  /** 生成申请码（用户发给管理员，管理员在管理端通过后才能真正绑定） */
  const handleBuildRequest = useCallback(() => {
    if (!profile) {
      Alert.alert('提示', '请先核对 QQ 资料')
      return
    }
    if (!confirmed) {
      Alert.alert('请先确认', '请先确认「这是我的 QQ」。')
      return
    }
    void buildRequestCode(profile.qq, profile.nickname).then(result => {
      if (!result.ok || !result.code) {
        Alert.alert('生成失败', result.message)
        return
      }
      setRequestCode(result.code)
      clipboardWriteText(result.code)
      toast('申请码已复制，发给管理员即可', 'long')
    })
  }, [confirmed, profile])

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

  /** QQ 必填：设备码只认机器，绑了 QQ 才知道这机器是谁的 */
  const ensureQQ = useCallback((): string | null => {
    const value = normalizeQQ(qq)
    if (!isValidQQ(value)) {
      Alert.alert('请填写 QQ', '需要填一个 QQ 号（5~12 位数字），管理员按 QQ 认人/封禁。')
      return null
    }
    return value
  }, [qq])

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
      const value = ensureQQ()
      if (!value) return
      void exec(async() => bindByWhitelist(value), enterIfActive)
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
    const value = ensureQQ()
    if (!value) return
    void exec(async() => {
      const res = await applyAuthString(text, value)
      if (res.ok) setCode('')
      return res
    }, enterIfActive)
  }, [code, enterIfActive, ensureQQ, exec])

  // 联网后发现自己刚被管理员授权：直接弹指纹（「管理员填完设备码他就能用」）
  useEffect(() => {
    if (status !== 'ready' || autoTried.current) return
    if (!isValidQQ(normalizeQQ(qq))) return
    autoTried.current = true
    const value = normalizeQQ(qq)
    void exec(async() => bindByWhitelist(value), enterIfActive)
  }, [enterIfActive, exec, qq, status])

  const primaryLabel = useMemo(() => {
    if (busy) return '处理中…'
    if (needUnlock) return '按指纹进入'
    if (needBind) return '绑定本机指纹'
    if (status === 'review') return '刷新审核结果'
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
            ? <Text style={{ color: status === 'review' ? '#e3b341' : '#8b93a1', fontSize: 12, marginTop: 8, lineHeight: 18 }}>{info.message}</Text>
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

          <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 14 }}>QQ 号（必填 · 管理员按它认人/封禁）</Text>
          {info.boundQQ
            ? (
              <Text style={{ color: '#7ee787', fontSize: 17, fontWeight: '700', letterSpacing: 1.2, marginTop: 6 }}>
                {info.boundQQ}（已绑定）
              </Text>
            )
            : (
              <View style={{ backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 10, paddingHorizontal: 10, marginTop: 6 }}>
                <Input
                  value={qq}
                  onChangeText={setQQ}
                  placeholder="输入你的 QQ 号，例如 12345678"
                  placeholderTextColor="#4b5563"
                  keyboardType="number-pad"
                  autoCorrect={false}
                  style={{ color: '#e5e7eb', minHeight: 44, fontSize: 14 }}
                />
              </View>
            )}
          <Text style={{ color: '#5a6270', fontSize: 11, marginTop: 6 }}>
            换手机后重新开通也要填同一个 QQ；被封禁的 QQ 换设备同样用不了。
          </Text>

          {!info.boundQQ
            ? (
              <View style={{ marginTop: 12 }}>
                <Button
                  onPress={handleLookupQQ}
                  style={{ backgroundColor: profileBusy ? '#2b303b' : '#3b9cff', borderRadius: 10, paddingVertical: 11, alignItems: 'center' }}
                >
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{profileBusy ? '正在核对该 QQ…' : '核对 QQ 资料（头像）'}</Text>
                </Button>

                {profile
                  ? (
                    <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center' }}>
                      <Image
                        source={{ uri: profile.avatar || avatarUrlOf(profile.qq) }}
                        style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#1c1f26' }}
                      />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={{ color: '#e5e7eb', fontSize: 15, fontWeight: '700' }}>{profile.qq}</Text>
                        <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 2 }}>{profile.nickname || '昵称：自动获取不可用'}</Text>
                        {profile.note
                          ? <Text style={{ color: '#e3b341', fontSize: 11, marginTop: 4, lineHeight: 16 }}>{profile.note}</Text>
                          : null}
                      </View>
                    </View>
                  )
                  : null}

                {profile
                  ? (
                    <>
                      <TouchableOpacity onPress={() => setConfirmed(v => !v)} style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center' }}>
                        <View style={{
                          width: 18, height: 18, borderRadius: 4, borderWidth: 1,
                          borderColor: confirmed ? '#7ee787' : '#4b5563',
                          backgroundColor: confirmed ? 'rgba(126,231,135,0.25)' : 'transparent',
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          {confirmed ? <Text style={{ color: '#7ee787', fontSize: 12 }}>✓</Text> : null}
                        </View>
                        <Text style={{ color: '#c9d1d9', fontSize: 12, marginLeft: 8 }}>确认这是我的 QQ</Text>
                      </TouchableOpacity>

                      <Button
                        onPress={handleBuildRequest}
                        style={{ backgroundColor: confirmed ? '#ff4d6d' : '#2b303b', borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 10 }}
                      >
                        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>生成授权申请码（发给管理员）</Text>
                      </Button>
                    </>
                  )
                  : null}

                {requestCode
                  ? (
                    <TouchableOpacity onPress={() => { clipboardWriteText(requestCode); toast('申请码已复制') }} style={{ marginTop: 10 }}>
                      <Text selectable style={{ color: '#7ee0ff', fontSize: 11, lineHeight: 16 }}>{requestCode}</Text>
                      <Text style={{ color: '#5a6270', fontSize: 11, marginTop: 4 }}>点上面的码复制 · 管理员核验头像后点「通过」才算开通</Text>
                    </TouchableOpacity>
                  )
                  : null}
              </View>
            )
            : null}

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
