/**
 * 设置 → 音源
 *
 * 三组「地址 + 密钥」：主 / 备 1 / 备 2。每个地址可以用自己的 API_KEY（留空则用主密钥）。
 * 主地址 0.1 秒内没结果，客户端并发打备用；主地址直接报错则立即补位（并发容灾）。
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
import { checkEndpointSecurity } from '@/core/source/protocol'
import { useTheme } from '@/store/theme/hook'

const refreshDelay = 800
const ROW_LABELS = ['主地址', '备用 1', '备用 2']

interface EndpointRow {
  url: string
  key: string
}

/** `地址|密钥` 逐行存储 → 三行 UI（密钥缺省用全局 token） */
const toRows = (raw: string, fallbackKey: string): EndpointRow[] => {
  const rows: EndpointRow[] = []
  for (const line of (raw || '').split('\n')) {
    const text = line.trim()
    if (!text) continue
    const [url, key] = text.split('|').map(part => part.trim())
    if (url) rows.push({ url, key: key || '' })
  }
  while (rows.length < 3) rows.push({ url: '', key: '' })
  if (!rows[0]!.key && fallbackKey) rows[0]!.key = fallbackKey
  return rows.slice(0, 3)
}

const fromRows = (rows: EndpointRow[]): string => rows
  .map(row => {
    const url = row.url.trim()
    if (!url) return ''
    const key = row.key.trim()
    return key ? `${url}|${key}` : url
  })
  .filter(Boolean)
  .join('\n')

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const savedEndpoints = useSettingValue('common.lxspEndpoints')
  const savedToken = useSettingValue('common.lxspToken')
  const [rows, setRows] = useState<EndpointRow[]>(() => toRows(savedEndpoints, savedToken))
  const [status, setStatus] = useState<SourceEngineStatus>(() => getEngineStatus())
  const savedPlugins = useSettingValue('common.wasmPlugins')
  const [pluginsDraft, setPluginsDraft] = useState(savedPlugins)
  const [probing, setProbing] = useState(false)

  useEffect(() => { setRows(toRows(savedEndpoints, savedToken)) }, [savedEndpoints, savedToken])
  useEffect(() => { setPluginsDraft(savedPlugins) }, [savedPlugins])

  const refresh = useCallback(() => { setStatus(getEngineStatus()) }, [])

  const patchRow = useCallback((index: number, patch: Partial<EndpointRow>) => {
    setRows(prev => {
      const next = prev.map(row => ({ ...row }))
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }, [])

  const handleSave = useCallback(() => {
    updateSetting({
      // 逐行 `地址|密钥`：每个地址可以用自己的 key
      'common.lxspEndpoints': fromRows(rows),
      // 全局密钥留主地址的，备用地址没填 key 时兜底用它
      'common.lxspToken': rows[0]?.key.trim() ?? '',
      'common.wasmPlugins': pluginsDraft.trim(),
    })
    setApiSource('lxsp')
    setTimeout(refresh, refreshDelay)
  }, [rows, pluginsDraft, refresh])

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

  // 只对「填了地址」的行给安全提示：公网明文会被拦截，本机/局域网明文只是提醒
  const securityNotes = useMemo(() => rows
    .map((row, index) => ({ index, security: checkEndpointSecurity(row.url) }))
    .filter(item => item.security.level !== 'invalid' && !item.security.ok), [rows])

  /**
   * 端点列表按「URL 匹配」回填标题。
   * 以前按数组下标套 ROW_LABELS：主地址留空时，备用 1 会被显示成「主地址」（错位）。
   */
  const labelOf = useCallback((baseUrl: string, fallbackIndex: number) => {
    const normalize = (value: string) => value.trim().replace(/\/+$/, '')
    const index = rows.findIndex(row => row.url.trim() && normalize(row.url) === normalize(baseUrl))
    return ROW_LABELS[index >= 0 ? index : fallbackIndex] ?? '备用'
  }, [rows])

  return (
    <SubTitle title={t('setting_basic_source')}>
      <View style={styles.list}>
        <Text size={13} color={theme['c-500']}>
          {`引擎：${status.inited ? '已就绪' : '未初始化'}　地址：${online}/${status.endpoints.length} 在线　可播放音源：${playable}`}
        </Text>
      </View>

      {
        rows.map((row, index) => (
          <View style={styles.group} key={ROW_LABELS[index]}>
            <Text size={13} color={theme['c-font-label']}>{`API_URL（${ROW_LABELS[index]}）`}</Text>
            <TextInput
              style={{ ...styles.input, color: theme['c-font'], borderColor: theme['c-350'] }}
              value={row.url}
              onChangeText={value => patchRow(index, { url: value })}
              placeholder={index === 0 ? 'https://c.wwwweb.top' : '可留空'}
              placeholderTextColor={theme['c-450']}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TextInput
              style={{ ...styles.input, ...styles.keyInput, color: theme['c-font'], borderColor: theme['c-350'] }}
              value={row.key}
              onChangeText={value => patchRow(index, { key: value })}
              placeholder={index === 0 ? '这个地址的 API_KEY' : '留空则用主密钥'}
              placeholderTextColor={theme['c-450']}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </View>
        ))
      }

      <View style={styles.group}>
        <Text size={13} color={theme['c-font-label']}>WASM 插件（JSON，可留空）</Text>
        <TextInput
          style={{ ...styles.input, height: 76, textAlignVertical: 'top', color: theme['c-font'], borderColor: theme['c-350'] }}
          value={pluginsDraft}
          onChangeText={setPluginsDraft}
          placeholder={'[{"name":"我的源","source":"kw","url":"https://example.com/plugin.wasm"}]'}
          placeholderTextColor={theme['c-450']}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text size={12} color={theme['c-500']} style={styles.hint}>
          {'插件跑在 App 自带的 wasm3 沙箱里：只能发 HTTP，读不到文件、拿不到系统权限'}
        </Text>
      </View>

      <View style={styles.btn}>
        <Button onPress={handleSave}>保存并重连</Button>
        <Button onPress={handleProbe} disabled={probing}>{probing ? '检测中…' : '测试连接'}</Button>
      </View>

      <Text size={12} color={theme['c-500']} style={styles.hint}>
        {'每个地址可以用自己的密钥；备用密钥留空就用主密钥。主地址超过 0.1 秒没结果会自动并发请求备用。'}
      </Text>

      <Text size={12} color={theme['c-500']} style={styles.hint}>
        {'安全：密钥只存在本机（不会再随包发布）。公网地址必须用 https —— 本机/局域网地址（127.0.0.1、192.168.x 等）才允许 http。'}
      </Text>
      {
        securityNotes.map(item => (
          <Text key={`sec-${item.index}`} size={12} color={theme['c-font-label']} style={styles.hint}>
            {`${ROW_LABELS[item.index]}：${item.security.reason ?? '地址不安全'}`}
          </Text>
        ))
      }

      <View style={styles.list}>
        {
          status.endpoints.length
            ? status.endpoints.map((item, index) => (
              <Text key={`${item.baseUrl}-${index}`} size={12} color={item.ok ? theme['c-500'] : theme['c-font-label']} style={styles.endpoint}>
                {`${item.ok ? '●' : '○'} [${labelOf(item.baseUrl, index)}] ${item.baseUrl}\n   ${item.ok ? `${item.provider ?? ''}${item.version ? ' v' + item.version : ''} · ${item.sources?.length ?? 0} 源` : (item.error ?? '未连接')}${item.latencyMs ? ` · ${item.latencyMs}ms` : ''}`}
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
  keyInput: { minHeight: 36 },
  btn: { marginTop: 12, flexDirection: 'row' },
  endpoint: { marginBottom: 6, lineHeight: 18 },
  hint: { marginTop: 8, lineHeight: 16 },
})
