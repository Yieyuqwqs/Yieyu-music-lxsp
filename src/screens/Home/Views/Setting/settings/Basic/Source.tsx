/**
 * 设置 → 音源
 *
 * 只有一件事：配置 LXSP 端点（URL + token），能力由端点 /manifest 自己声明。
 * 旧版 JS 脚本沙箱已彻底移除：App 里不再有任何执行第三方脚本的代码。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { TextInput, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import Text from '@/components/common/Text'
import { createStyle, toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { getEngineStatus, probeEndpoints, setApiSource, type SourceEngineStatus } from '@/core/apiSource'
import { parseCustomSources } from '@/core/source'
import { useTheme } from '@/store/theme/hook'

const refreshDelay = 800

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const savedEndpoints = useSettingValue('common.lxspEndpoints')
  const savedToken = useSettingValue('common.lxspToken')
  const savedCustom = useSettingValue('common.customSources')
  const [endpointsDraft, setEndpointsDraft] = useState(savedEndpoints)
  const [tokenDraft, setTokenDraft] = useState(savedToken)
  const [customDraft, setCustomDraft] = useState(savedCustom)
  const [status, setStatus] = useState<SourceEngineStatus>(() => getEngineStatus())
  const [probing, setProbing] = useState(false)

  useEffect(() => { setEndpointsDraft(savedEndpoints) }, [savedEndpoints])
  useEffect(() => { setTokenDraft(savedToken) }, [savedToken])
  useEffect(() => { setCustomDraft(savedCustom) }, [savedCustom])

  const refresh = useCallback(() => {
    setStatus(getEngineStatus())
  }, [])

  const handleSave = useCallback(() => {
    // 通用源是自由 JSON，保存前先校验，别让一个逗号把音源全搞挂
    try {
      const count = parseCustomSources(customDraft).length
      if (count) toast(`已启用 ${count} 个通用 API 源`)
    } catch (error) {
      toast(`通用源配置有误：${(error as Error).message}`, 'long')
      return
    }
    updateSetting({
      'common.lxspEndpoints': endpointsDraft.trim(),
      'common.lxspToken': tokenDraft.trim(),
      'common.customSources': customDraft.trim(),
    })
    setApiSource('lxsp')
    setTimeout(refresh, refreshDelay)
  }, [endpointsDraft, tokenDraft, customDraft, refresh])

  const handleProbe = useCallback(() => {
    setProbing(true)
    void probeEndpoints()
      .then(endpoints => { setStatus({ ...getEngineStatus(), endpoints }) })
      .finally(() => { setProbing(false) })
  }, [])

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
        <Text size={13} color={theme['c-font-label']}>端点地址（LXSP v2 格式；换行可加镜像）</Text>
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
          placeholder="端点要求的访问密钥（没有就留空）"
          placeholderTextColor={theme['c-450']}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </View>

      <View style={styles.field}>
        <Text size={13} color={theme['c-font-label']}>通用 API 源（JSON，可留空）</Text>
        <TextInput
          style={{ ...styles.input, height: 110, textAlignVertical: 'top', color: theme['c-font'], borderColor: theme['c-350'] }}
          value={customDraft}
          onChangeText={setCustomDraft}
          placeholder={'[{"name":"某某解析","baseUrl":"https://api.example.com","token":"xxx","source":"kw","request":{"method":"POST","path":"/api/parse","body":{"id":"{id}","src":"{source}"},"auth":{"in":"header","name":"X-Api-Key"}},"response":{"url":"$.data.url","error":"$.msg"}}]'}
          placeholderTextColor={theme['c-450']}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text size={12} color={theme['c-500']} style={styles.hint}>
          {'填了就走你的接口：{id}/{source}/{quality} 会被替换，响应按 JSONPath 取（如 $.data.url）'}
        </Text>
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
            : <Text size={12} color={theme['c-500']}>还没有可用端点：填一个 LXSP 服务地址，例如本机网关 http://127.0.0.1:1101</Text>
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
  hint: {
    marginTop: 6,
    lineHeight: 16,
  },
})
