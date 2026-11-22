import { memo, useCallback, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import musicSdk from '@/utils/musicSdk'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'

interface Result {
  source: string
  name: string
  ms: number | null
}

const runTest = async(onResult: (result: Result) => void) => {
  const sources = (musicSdk as any).sources as Array<{ id: string, name: string }>
  for (const source of sources) {
    const start = Date.now()
    let ms: number | null = null
    try {
      const api = (musicSdk as any)[source.id]
      if (api?.musicSearch?.search) {
        await api.musicSearch.search('测试', 1, 1).promise
        ms = Date.now() - start
      }
    } catch {
      ms = null
    }
    onResult({ source: source.id, name: source.name, ms })
  }
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const [isTesting, setIsTesting] = useState(false)
  const [results, setResults] = useState<Result[]>([])

  const handleTest = useCallback(() => {
    if (isTesting) return
    setIsTesting(true)
    setResults([])
    void runTest(result => {
      setResults(prev => [...prev, result])
    }).catch(() => {
      toast(t('setting_other_speed_test_failed'))
    }).finally(() => {
      setIsTesting(false)
    })
  }, [isTesting, t])

  return (
    <SubTitle title={t('setting_other_speed_test')}>
      <TouchableOpacity
        style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-300'] }}
        onPress={handleTest}
        activeOpacity={0.7}
      >
        <Text size={13}>{isTesting ? t('setting_other_speed_testing') : t('setting_other_speed_test_btn')}</Text>
      </TouchableOpacity>
      <View style={styles.list}>
        {
          results.map(item => (
            <Text key={item.source} size={12} color={theme['c-font-label']} style={styles.item}>
              {`${item.name}：${item.ms == null ? t('setting_other_speed_test_error') : `${item.ms}ms`}`}
            </Text>
          ))
        }
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  btn: {
    alignSelf: 'flex-start',
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 8,
  },
  list: {
    marginTop: 8,
  },
  item: {
    marginBottom: 4,
  },
})
