/**
 * 设置 → 音源
 *
 * 只有两格要填：API_URL 和 API_KEY。
 * 支持两种后端，客户端自己判断，不需要用户懂协议：
 *   1. LXSP v2（有 /manifest）
 *   2. 标准 API 模式（POST /music/url + X-Api-Key，如 c.wwwweb.top 这类）
 */
import { memo, useCallback, useEffect, useState } from 'react'
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

const refreshDelay = 800

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const savedUrl = useSettingValue('common.lxspEndpoints')
  const savedKey = useSettingValue('common.lxspToken')
  const [urlDraft, setUrlDraft] = useState(savedUrl)
  const [keyDraft, setKeyDraft] = useState(savedKey)
  const [status, setStatus] = useState<SourceEngineStatus>(() => getEngineStatus())
  const [probing, setProbing] = useState(false)

  useEffect(() => { setUrlDraft(savedUrl) }, [savedUrl])
  useEffect(() => { setKeyDraft(savedKey) }, [savedKey])

  const refresh = useCallback(() => {
    setStatus(getEngineStatus())
  }, [])

  const handleSave = useCallback(() => {
    updateSetting({
      'common.lxspEndpoints': urlDraft.trim(),
      'common.lxspToken': keyDraft.trim(),
    })
    setApiSource('lxsp')
    setTimeout(refresh, refreshDelay)
  }, [urlDraft, keyDraft, refresh])

  const handleProbe = useCallback(() => {
    setProbing(true)
    void probeEndpoints()
      .then(endpoints => { setStatus({ ...getEngineStatus(), endpoints }) })
      .finally(() => { setProbing(false) })
  }, [])

  const playable = status.sources.length ? status.sources.join(' / ') : '无可播放音源'

  return (
    <SubTitle title={t('setting_basic_source')}>
      <View style={styles.list}>
        <Text size={13} color={theme['c-500']}>
          {`引擎：${status.inited ? '已就绪' : '未初始化'}　端点：${status.endpoints.filter(e => e.ok).length}/${status.endpoints.length} 在线`}
        </Text>
        <Text size={13} color={theme['c-500']}>{`可播放音源：${playable}`}</Text>
      </View>

      <View style={styles.field}>
        <Text size={13} color={theme['c-font-label']}>API_URL</Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={urlDraft}
          onChangeText={setUrlDraft}
          placeholder="https://c.wwwweb.top"
          placeholderTextColor={theme['c-450']}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>

      <View style={styles.field}>
        <Text size={13} color={theme['c-font-label']}>API_KEY</Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={keyDraft}
          onChangeText={setKeyDraft}
          placeholder="对方给的密钥"
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
                {`${item.ok ? '●' : '○'} ${item.baseUrl}\n   ${item.ok ? `${item.provider ?? ''}${item.version ? ' v' + item.version : ''} · ${item.sources?.length ?? 0} 源` : (item.error ?? '未连接')}${item.latencyMs ? ` · ${item.latencyMs}ms` : ''}${item.health ? ` · ${item.health}` : ''}`}
              </Text>
            ))
            : <Text size={12} color={theme['c-500']}>填 API_URL + API_KEY，点「保存并重连」</Text>
        }
      </View>
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
})
