/**
 * 设置 → 一起听
 *
 * 极简交互：填服务器 → 建房或加入 → 看成员 → 控制端直接控，成员端「申请」。
 * 音频永远不经服务端，这里只同步「放什么、放到哪」。
 */
import { Component, memo, useCallback, useEffect, useState } from 'react'
import { Alert, TextInput, View } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { listenTogether, type RoomStatus } from '@/core/listen-together'
import { useTheme } from '@/store/theme/hook'

/** 面板级错误边界：一起听出问题只影响这一块，不再让设置页白屏 */
class PanelBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.group}>
          <Text size={13} color="#e5484d">{`一起听面板出错：${this.state.error.message}`}</Text>
          <Text size={12} style={styles.hint}>点下面按钮重试；播放不受影响。</Text>
          <View style={styles.btnRow}>
            <Button onPress={() => this.setState({ error: null })}>重试面板</Button>
          </View>
        </View>
      )
    }
    return this.props.children
  }
}
const PanelContent = memo(() => {
  const theme = useTheme()
  const savedServer = useSettingValue('common.listenTogetherServer')
  const savedRoom = useSettingValue('common.listenTogetherRoom')
  const [server, setServer] = useState(savedServer)
  const [roomDraft, setRoomDraft] = useState(savedRoom)
  const [status, setStatus] = useState<RoomStatus>(() => listenTogether.getStatus())
  const [busy, setBusy] = useState(false)

  useEffect(() => setServer(savedServer), [savedServer])

  useEffect(() => listenTogether.subscribe(setStatus), [])

  // 每秒刷新一次房间播放头（这就是「实时同步歌曲状态」的显示端）
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!status.roomId) return
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [status.roomId])

  const fmt = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }

  const run = useCallback((task: () => Promise<unknown>) => {
    setBusy(true)
    void task()
      .catch((error: Error) => { /* 错误通过 status.lastError 呈现 */ })
      .finally(() => setBusy(false))
  }, [])

  const handleSaveServer = useCallback(() => {
    updateSetting({ 'common.listenTogetherServer': server.trim() })
  }, [server])

  const handleCreate = useCallback(() => {
    updateSetting({ 'common.listenTogetherServer': server.trim() })
    run(async() => {
      const joined = await listenTogether.createRoom()
      updateSetting({ 'common.listenTogetherRoom': joined.roomId })
      setRoomDraft(joined.roomId)
    })
  }, [run, server])

  const handleJoin = useCallback(() => {
    updateSetting({ 'common.listenTogetherServer': server.trim() })
    run(async() => {
      const joined = await listenTogether.join(roomDraft)
      updateSetting({ 'common.listenTogetherRoom': joined.roomId })
    })
  }, [run, roomDraft, server])

  const handleLeave = useCallback(() => { run(() => listenTogether.leave()) }, [run])

  const isController = status.role === 'CONTROLLER'
  const inRoom = !!status.roomId

  return (
    <SubTitle title="一起听">
      <View style={styles.group}>
        <Text size={13}>{`通道：${status.transport === 'direct' ? '直连 UDP' : status.transport === 'relay' ? 'MQTT 中转' : '正在打洞…'}${status.connected ? '' : '（未连接）'}　房间：${status.roomId ?? '-'}　身份：${status.role ? (isController ? '控制端' : '成员') : '-'}`}</Text>
        <Text size={12} color={theme['c-500']} style={styles.hint}>{`原生能力：${status.engine?.sync && status.engine?.direct ? 'C++ 直连 + C++ 同步' : status.engine?.sync ? '仅 C++ 同步' : status.engine?.direct ? '仅 C++ 直连' : '无（全走 JS）'}　身份：${isController ? '控制端' : '成员'}`}</Text>
        {status.lastEvent ? <Text size={12} color={theme['c-500']} style={styles.hint}>{status.lastEvent}</Text> : null}
        {status.lastError ? <Text size={12} color={theme['c-500']} style={styles.hint}>{status.lastError}</Text> : null}
      </View>

      <View style={styles.group}>
        <Text size={13} color={theme['c-font-label']}>服务器地址</Text>
        <Text size={12} color={theme['c-500']} style={styles.hint}>
          填 p2p 就是「免部署」模式：不建服务器、不要域名，直接走公共消息通道（推荐）。两边填同一个房号即可。
        </Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={server}
          onChangeText={setServer}
          onBlur={handleSaveServer}
          placeholder="p2p（免部署） 或 https://你的服务器"
          placeholderTextColor={theme['c-450']}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>

      <View style={styles.group}>
        <Text size={13} color={theme['c-font-label']}>房间号</Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={roomDraft}
          onChangeText={setRoomDraft}
          placeholder="房主点创建后自动生成，成员粘贴同一个房号"
          placeholderTextColor={theme['c-450']}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {inRoom
        ? (
          <View style={styles.btnRow}>
            <Button onPress={() => Clipboard.setString(status.roomId ?? '')}>复制房号</Button>
          </View>
        )
        : null}

      <View style={styles.btnRow}>
        <Button onPress={handleCreate} disabled={busy}>{busy ? '处理中…' : '创建房间（我是房主）'}</Button>
        <Button onPress={handleJoin} disabled={busy || !roomDraft.trim()}>加入房间（我是成员）</Button>
        <Button onPress={handleLeave} disabled={busy || !inRoom}>离开</Button>
      </View>

      {status.nowPlaying
        ? (
          <View style={styles.group}>
            <Text size={13} color={theme['c-font-label']}>{`正在播放（房间）`}</Text>
            <Text size={13}>{`${status.nowPlaying.isPlaying ? '▶ ' : '⏸ '}${status.nowPlaying.name} - ${status.nowPlaying.singer}`}</Text>
            <Text size={12} color={theme['c-500']} style={styles.hint}>{`${fmt(typeof listenTogether.playheadMs === 'function' ? listenTogether.playheadMs() : status.positionMs)} · 与房间同步`}</Text>
          </View>
        )
        : null}
      {inRoom
        ? (
          <View style={styles.group}>
            <Text size={13} color={theme['c-font-label']}>{`共享队列（${status.queue.length}）—— 谁都能加，实时同步`}</Text>
            {status.queue.length === 0
              ? <Text size={12} color={theme['c-500']} style={styles.hint}>还没有歌。放一首歌后点下面「把当前歌曲加入队列」。</Text>
              : status.queue.map((track, index) => (
                <View key={track.stableKey} style={styles.queueRow}>
                  <Text
                    size={12}
                    color={index === status.currentIndex ? theme['c-font'] : theme['c-500']}
                    onPress={() => listenTogether.playQueueIndex?.(index)}
                    style={styles.queueText}
                  >
                    {`${index === status.currentIndex ? '▶ ' : ''}${index + 1}. ${track.name} - ${track.singer}`}
                  </Text>
                  <Text size={12} color={theme['c-500']} onPress={() => listenTogether.removeFromQueue?.(track.stableKey)}>
                    {`删除`}
                  </Text>
                </View>
              ))}
            <View style={styles.btnRow}>
              <Button onPress={() => listenTogether.addCurrentToQueue?.()}>把当前歌曲加入队列</Button>
              <Button onPress={() => {
                void (async() => {
                  const result = await listenTogether.runPlaybackSelfTest?.()
                  if (!result) return
                  const probeLine = result.probe
                    ? `probe http=${result.probe.status} 字节=${result.probe.bytes} 类型=${result.probe.type || '-'}`
                    : 'probe 无直链（本机解析）'
                  if (result.ok) {
                    Alert.alert(
                      '✅ 自检通过',
                      `duration=${result.durationMs}ms  position=${result.positionMs}ms  state=${result.state}\n${probeLine}\n${result.url.slice(0, 80)}`,
                    )
                  } else {
                    Alert.alert(
                      '❌ 链路彻底失败',
                      `duration=${result.durationMs}ms  position=${result.positionMs}ms  state=${result.state}\n${probeLine}\n错误：${result.error ?? '播放器未拿到媒体信息'}\n链接：${result.url.slice(0, 80) || '-'}`,
                    )
                  }
                })()
              }}>播放自检</Button>
            </View>
          </View>
        )
        : null}
      {inRoom
        ? (
          <View style={styles.group}>
            <Text size={13} color={theme['c-font-label']}>{`成员（${status.members.length}）`}</Text>
            {status.members.map(member => (
              <Text key={member.memberId} size={12} color={theme['c-500']} style={styles.member}>
                {`${member.role === 'CONTROLLER' ? '房主' : '成员'}　${member.online ? '在线' : '离线'}　${member.memberId.slice(0, 8)}`}
              </Text>
            ))}
            <Text size={12} color={theme['c-500']} style={styles.hint}>
              {isController
                ? '你的播放/暂停/拖动会自动同步给房间；换曲后请点「同步当前歌曲」'
                : '你只能申请，由房主同意前不会改变播放状态'}
            </Text>
          </View>
        )
        : null}

      {inRoom && !isController
        ? (
          <View style={styles.btnRow}>
            <Button onPress={() => listenTogether.requestPlay()}>申请播放</Button>
            <Button onPress={() => listenTogether.requestPause()}>申请暂停</Button>
          </View>
        )
        : null}
    </SubTitle>
  )
})

export default memo(() => (
  <PanelBoundary>
    <PanelContent />
  </PanelBoundary>
))

const styles = createStyle({
  group: { marginTop: 10 },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 13,
    minHeight: 40,
  },
  btnRow: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap' },
  member: { marginTop: 4 },
  queueRow: { marginTop: 6, flexDirection: 'row', alignItems: 'center' },
  queueText: { flex: 1, lineHeight: 18 },
  hint: { marginTop: 6, lineHeight: 16 },
})
