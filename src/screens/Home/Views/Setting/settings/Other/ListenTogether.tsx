/**
 * 设置 → 一起听
 *
 * 极简交互：填服务器 → 建房或加入 → 看成员 → 控制端直接控，成员端「申请」。
 * 音频永远不经服务端，这里只同步「放什么、放到哪」。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { TextInput, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { listenTogether, type RoomStatus } from '@/core/listen-together'
import { useTheme } from '@/store/theme/hook'

export default memo(() => {
  const theme = useTheme()
  const savedServer = useSettingValue('common.listenTogetherServer')
  const savedRoom = useSettingValue('common.listenTogetherRoom')
  const [server, setServer] = useState(savedServer)
  const [roomDraft, setRoomDraft] = useState(savedRoom)
  const [status, setStatus] = useState<RoomStatus>(() => listenTogether.getStatus())
  const [busy, setBusy] = useState(false)

  useEffect(() => setServer(savedServer), [savedServer])

  useEffect(() => listenTogether.subscribe(setStatus), [])

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
        <Text size={13}>{`状态：${status.connected ? '已连接' : '未连接'}${status.roomId ? `　房间：${status.roomId}` : ''}${status.role ? `　身份：${isController ? '控制端' : '成员'}` : ''}`}</Text>
        {status.lastError ? <Text size={12} color={theme['c-500']} style={styles.hint}>{status.lastError}</Text> : null}
      </View>

      <View style={styles.group}>
        <Text size={13} color={theme['c-font-label']}>服务器地址</Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={server}
          onChangeText={setServer}
          onBlur={handleSaveServer}
          placeholder="https://listening-room.xxx.workers.dev"
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
          placeholder="创建后自动填入，或粘贴好友的房号"
          placeholderTextColor={theme['c-450']}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.btnRow}>
        <Button onPress={handleCreate} disabled={busy}>{busy ? '处理中…' : '创建房间'}</Button>
        <Button onPress={handleJoin} disabled={busy || !roomDraft.trim()}>加入房间</Button>
        <Button onPress={handleLeave} disabled={busy || !inRoom}>离开</Button>
      </View>

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

      {inRoom
        ? (
          <View style={styles.btnRow}>
            {isController
              ? (
                <>
                  <Button onPress={() => listenTogether.pushPlay()}>同步播放</Button>
                  <Button onPress={() => listenTogether.pushPause()}>同步暂停</Button>
                  <Button onPress={() => listenTogether.pushTrack()}>同步当前歌曲</Button>
                </>
              )
              : (
                <>
                  <Button onPress={() => listenTogether.requestPlay()}>申请播放</Button>
                  <Button onPress={() => listenTogether.requestPause()}>申请暂停</Button>
                </>
              )}
          </View>
        )
        : null}
    </SubTitle>
  )
})

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
  hint: { marginTop: 6, lineHeight: 16 },
})
