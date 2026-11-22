import { memo, useCallback, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import InputItem from '../../components/InputItem'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { setNavActiveId } from '@/core/common'
import { recognizeSong, type RecognizeResult } from '@/core/musicRecognize'
import { createStyle, openUrl, toast } from '@/utils/tools'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const host = useSettingValue('recognize.acrHost')
  const accessKey = useSettingValue('recognize.acrKey')
  const secret = useSettingValue('recognize.acrSecret')
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<RecognizeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRecognize = useCallback(() => {
    if (isRunning) return
    setIsRunning(true)
    setError(null)
    setResult(null)
    toast(t('recognize_listening'), 'long')
    void recognizeSong().then(setResult).catch((err: Error) => {
      setError(err?.message ?? t('recognize_failed'))
    }).finally(() => {
      setIsRunning(false)
    })
  }, [isRunning, t])

  const handleSearch = useCallback(() => {
    if (!result) return
    setNavActiveId('nav_search')
    setTimeout(() => {
      global.app_event.searchTextFromDeeplink(`${result.title} ${result.artists}`.trim())
    }, 300)
  }, [result])

  return (
    <SubTitle title={t('setting_other_recognize')}>
      <InputItem value={host} label={t('recognize_host')} placeholder="识别服务器 Host（如 identify-cn-north-1.acrcloud.cn）" onChanged={(text: string) => { updateSetting({ 'recognize.acrHost': text.trim() }) }} />
      <InputItem value={accessKey} label={t('recognize_key')} placeholder="access_key" onChanged={(text: string) => { updateSetting({ 'recognize.acrKey': text.trim() }) }} />
      <InputItem value={secret} label={t('recognize_secret')} placeholder="access_secret" onChanged={(text: string) => { updateSetting({ 'recognize.acrSecret': text.trim() }) }} />
      <View style={styles.row}>
        <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-300'] }} onPress={handleRecognize}>
          <Text size={12}>{isRunning ? t('recognize_listening') : t('recognize_start')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={{ ...styles.btn, marginLeft: 10 }} onPress={() => { void openUrl('https://console.acrcloud.cn/#/projects') }}>
          <Text size={12} color={theme['c-font-label']}>{t('recognize_console')}</Text>
        </TouchableOpacity>
      </View>
      {
        result
          ? <View style={styles.result}>
              <Text size={13}>{`${result.title}${result.artists ? ' - ' + result.artists : ''}`}</Text>
              {result.album ? <Text size={11} color={theme['c-font-label']}>{result.album}</Text> : null}
              <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-200'], marginTop: 8 }} onPress={handleSearch}>
                <Text size={12}>{t('recognize_search')}</Text>
              </TouchableOpacity>
            </View>
          : null
      }
      {error ? <Text size={11} color="#e64545" style={styles.error}>{error}</Text> : null}
    </SubTitle>
  )
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  btn: {
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  result: {
    marginTop: 10,
  },
  error: {
    marginTop: 8,
  },
})
