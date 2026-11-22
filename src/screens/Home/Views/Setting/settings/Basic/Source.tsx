/**
 * 设置 → 音源
 *
 * 旧版本这里是「内置 api + 导入 JS 脚本」两个列表；
 * 新架构下只剩一件事：配置 LXSP 端点（URL + token），能力由端点 /manifest 自己声明。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { getEngineStatus, probeEndpoints, setApiSource, type SourceEngineStatus } from '@/core/apiSource'
import { useTheme } from '@/store/theme/hook'
import { useUserApiList } from '@/store/userApi'
import UserApiEditModal, { type UserApiEditModalType } from './UserApiEditModal'

const refreshDelay = 800

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const savedEndpoints = useSettingValue('common.lxspEndpoints')
  const savedToken = useSettingValue('common.lxspToken')
  const [endpointsDraft, setEndpointsDraft] = useState(savedEndpoints)
  const [tokenDraft, setTokenDraft] = useState(savedToken)
  const [status, setStatus] = useState<SourceEngineStatus>(() => getEngineStatus())
  const [probing, setProbing] = useState(false)
  const legacyList = useUserApiList()

  useEffect(() => { setEndpointsDraft(savedEndpoints) }, [savedEndpoints])
  useEffect(() => { setTokenDraft(savedToken) }, [savedToken])

  const refresh = useCallback(() => {
    setStatus(getEngineStatus())
  }, [])

  const handleSave = useCallback(() => {
    updateSetting({
      'common.lxspEndpoints': endpointsDraft.trim(),
      'common.lxspToken': tokenDraft.trim(),
    })
    setApiSource('lxsp')
    setTimeout(refresh, refreshDelay)
  }, [endpointsDraft, tokenDraft, refresh])

  const handleProbe = useCallback(() => {
    setProbing(true)
    void probeEndpoints()
      .then(endpoints => { setStatus({ ...getEngineStatus(), endpoints }) })
      .finally(() => { setProbing(false) })
  }, [])

  const modalRef = useRef<UserApiEditModalType>(null)
  const handleShowLegacy = useCallback(() => { modalRef.current?.show() }, [])

  const playable = status.sources.length
    ? status.sources.join(' / ')
    : '无可播放音源'

  return (
    <SubTitle title={t('setting_basic_source')}>
      <View style={styles.list}>
        <Text size={13} color={theme['c-500']}>
          {`引擎：${status.inited ? '已就绪' : '未初始化'}　端点：${status.endpoints.filter(e => e.ok).length}/${status.endpoints.length} 在线`}
        </Text>
        <Text size={13} color={theme['c-500']}>
          {`可播放音源：${playable}`}
        </Text>
        <Text size={13} color={theme['c-500']}>
          {`提供方 Provider：${status.providerCount}`}
        </Text>
      </View>

      <View style={styles.field}>
        <Text size={13} color={theme['c-font-label']}>端点地址（换行分隔，支持 主端点 + 镜像）</Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={endpointsDraft}
          onChangeText={setEndpointsDraft}
          placeholder="http://127.0.0.1:1101"
          placeholderTextColor={theme['c-450']}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>

      <View style={styles.field}>
        <Text size={13} color={theme['c-font-label']}>访问令牌（Authorization: Bearer）</Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={tokenDraft}
          onChangeText={setTokenDraft}
          placeholder="留空表示端点不鉴权"
          placeholderTextColor={theme['c-450']}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </View>

      <View style={styles.btn}>
        <Button onPress={handleSave}>保存并重连</Button>
        <Button onPress={handleProbe} disabled={probing}>{probing ? '检测中…' : '测试连接'}</Button>
      </View>

      <View style={styles.list}>
        {
          status.endpoints.length
            ? status.endpoints.map(item => (
              <Text key={item.baseUrl} size={12} color={item.ok ? theme['c-500'] : theme['c-font-label']} style={styles.endpoint}>
                {`${item.ok ? '●' : '○'} ${item.baseUrl}\n   ${item.ok ? `${item.provider ?? ''} v${item.version ?? ''} · ${item.sources?.length ?? 0} 源` : (item.error ?? '未连接')}${item.latencyMs ? ` · ${item.latencyMs}ms` : ''}${item.health ? ` · ${item.health}` : ''}`}
              </Text>
            ))
            : <Text size={12} color={theme['c-500']}>还没有可用端点：填一个 LXSP 服务地址，例如本机网关 http://127.0.0.1:1101</Text>
        }
      </View>

      <View style={styles.legacy}>
        <Text size={13} color={theme['c-font-label']}>
          {`旧版 JS 脚本音源：已停用（${legacyList.length} 个）—— 脚本不再被执行，能力统一由 LXSP 端点提供`}
        </Text>
        {
          legacyList.length
            ? <View style={styles.btn}><Button onPress={handleShowLegacy}>清理旧脚本</Button></View>
            : null
        }
      </View>

      <UserApiEditModal ref={modalRef} />
    </SubTitle>
  )
})

const styles = createStyle({
  list: {
    flexGrow: 0,
    flexShrink: 1,
    marginBottom: 6,
  },
  field: {
    marginTop: 10,
    marginBottom: 2,
  },
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
  btn: {
    marginTop: 10,
    flexDirection: 'row',
  },
  endpoint: {
    marginBottom: 6,
    lineHeight: 18,
  },
  legacy: {
    marginTop: 16,
  },
})
