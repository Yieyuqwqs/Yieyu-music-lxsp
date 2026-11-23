/**
 * 设置 → 音源
 *
 * 三格 API_URL（主 / 备 1 / 备 2）+ 一格 API_KEY。
 * 主地址 0.1 秒内没有结果，客户端会并发打备用地址，谁先成功用谁（并发容灾）。
 * 支持两种后端，客户端自己判断：LXSP v2（有 /manifest）或标准 API 模式（POST /music/url）。
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
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
const LABELS = ['API_URL（主）', 'API_URL（备 1）', 'API_URL（备 2）']

const toUrls = (raw: string): string[] => {
  const list = (raw || '').split(/[\n,]+/).map(item => item.trim()).filter(Boolean)
  return [list[0] ?? '', list[1] ?? '', list[2] ?? '']
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const savedUrls = useSettingValue('common.lxspEndpoints')
  const savedKey = useSettingValue('common.lxspToken')
  const [urls, setUrls] = useState<string[]>(() => toUrls(savedUrls))
  const [keyDraft, setKeyDraft] = useState(savedKey)
  const [status, setStatus] = useState<SourceEngineStatus>(() => getEngineStatus())
  const [probing, setProbing] = useState(false)

  useEffect(() => { setUrls(toUrls(savedUrls)) }, [savedUrls])
  useEffect(() => { setKeyDraft(savedKey) }, [savedKey])

  const refresh = useCallback(() => { setStatus(getEngineStatus()) }, [])

  const setUrlAt = useCallback((index: number, value: string) => {
    setUrls(prev => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }, [])

  const handleSave = useCallback(() => {
    updateSetting({
      // 空行不算数；顺序即优先级（主 → 备 1 → 备 2）
      'common.lxspEndpoints': urls.map(item => item.trim()).filter(Boolean).join('\n'),
      'common.lxspToken': keyDraft.trim(),
    })
    setApiSource('lxsp')
    setTimeout(refresh, refreshDelay)
  }, [urls, keyDraft, refresh])

  const handleProbe = useCallback(() => {
    setProbing(true)
    void probeEndpoints()
      .then(endpoints => { setStatus({ ...getEngineStatus(), endpoints }) })
      .finally(() => { setProbing(false) })
  }, [])

  const playable = useMemo(
    () => (status.sources.length ? status.sources.join(' / ') : '无可播放音源'),
    [status.sources],
  )
  const online = status.endpoints.filter(item => item.ok).length

  return (
    <SubTitle title={t('setting_basic_source')}>
      <View style={styles.list}>
        <Text size={13} color={theme['c-500']}>
          {`引擎：${status.inited ? '已就绪' : '未初始化'}　地址：${online}/${status.endpoints.length} 在线　可播放音源：${playable}`}
        </Text>
      </View>

      {
        LABELS.map((label, index) => (
          <View style={styles.field} key={label}>
            <Text size={13} color={theme['c-font-label']}>{label}</Text>
            <TextInput
              style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
              value={urls[index]}
              onChangeText={value => setUrlAt(index, value)}
              placeholder={index === 0 ? 'https://c.wwwweb.top' : '可留空'}
              placeholderTextColor={theme['c-450']}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        ))
      }

      <View style={styles.field}>
        <Text size={13} color={theme['c-font-label']}>API_KEY</Text>
        <TextInput
          style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
          value={keyDraft}
          onChangeText={setKeyDraft}
          placeholder="对方给的密钥（没有就留空）"
          placeholderTextColor={theme['c-450']}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Text size={12} color={theme['c-500']} style={styles.hint}>
          {'主地址超过 0.1 秒没结果，会自动并发请求备用地址，谁先成功用谁'}
        </Text>
      </View>

      <View style={styles.btn}>
        <Button onPress={handleSave}>保存并重连</Button>
        <Button onPress={handleProbe} disabled={probing}>{probing ? '检测中…' : '测试连接'}</Button>
      </View>

      <View style={styles.list}>
        {
          status.endpoints.length
            ? status.endpoints.map((item, index) => (
              <Text key={`${item.baseUrl}-${index}`} size={12} color={item.ok ? theme['c-500'] : theme['c-font-label']} style={styles.endpoint}>
                {`${item.ok ? '●' : '○'} ${index === 0 ? '[主] ' : `[备${index}] `}${item.baseUrl}\n   ${item.ok ? `${item.provider ?? ''}${item.version ? ' v' + item.version : ''} · ${item.sources?.length ?? 0} 源` : (item.error ?? '未连接')}${item.latencyMs ? ` · ${item.latencyMs}ms` : ''}`}
              </Text>
            ))
            : <Text size={12} color={theme['c-500']}>填主地址 + 密钥，点「保存并重连」；备用地址可留空</Text>
        }
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  list: { flexGrow: 0, flexShrink: 1, marginBottom: 6 },
  field: { marginTop: 10, marginBottom: 2 },
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
  btn: { marginTop: 10, flexDirection: 'row' },
  endpoint: { marginBottom: 6, lineHeight: 18 },
  hint: { marginTop: 6, lineHeight: 16 },
})
