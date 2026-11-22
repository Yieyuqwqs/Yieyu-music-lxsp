import { memo } from 'react'
import { TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import CheckBoxItem from '../../components/CheckBoxItem'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'

const STEP = 500

const OffsetBtn = ({ text, onPress }: { text: string, onPress: () => void }) => {
  const theme = useTheme()
  return (
    <TouchableOpacity
      style={{ ...styles.offsetBtn, backgroundColor: theme['c-primary-alpha-200'] }}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text size={12}>{text}</Text>
    </TouchableOpacity>
  )
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const offset = useSettingValue('playDetail.lrcOffset')
  const isShowWordLyric = useSettingValue('playDetail.isShowWordLyric')
  const gestureEnable = useSettingValue('playDetail.gestureEnable')
  const isDiscRotate = useSettingValue('playDetail.isDiscRotate')
  const isFadeIn = useSettingValue('player.isFadeIn')
  const timeoutFade = useSettingValue('player.timeoutExitFade')
  const radioMode = useSettingValue('player.radioMode')

  return (
    <SubTitle title={t('setting_play_experience')}>
      <View style={styles.offsetRow}>
        <Text size={12} color={theme['c-font-label']}>{`${t('setting_play_lrc_offset')}  ${offset > 0 ? '+' : ''}${offset}ms`}</Text>
        <View style={styles.offsetBtns}>
          <OffsetBtn text="-0.5s" onPress={() => { updateSetting({ 'playDetail.lrcOffset': Math.max(-3000, offset - STEP) }) }} />
          <OffsetBtn text="+0.5s" onPress={() => { updateSetting({ 'playDetail.lrcOffset': Math.min(3000, offset + STEP) }) }} />
          <OffsetBtn text={t('setting_play_lrc_offset_reset')} onPress={() => { updateSetting({ 'playDetail.lrcOffset': 0 }) }} />
        </View>
      </View>
      <CheckBoxItem check={isShowWordLyric} label={t('setting_play_word_lyric')} onChange={(v: boolean) => { updateSetting({ 'playDetail.isShowWordLyric': v }) }} />
      <CheckBoxItem check={isDiscRotate} label={t('setting_play_disc_rotate')} onChange={(v: boolean) => { updateSetting({ 'playDetail.isDiscRotate': v }) }} />
      <CheckBoxItem check={radioMode} label={t('setting_play_radio_mode')} onChange={(v: boolean) => { updateSetting({ 'player.radioMode': v }) }} />
      <CheckBoxItem check={isFadeIn} label={t('setting_play_fade_in')} onChange={(v: boolean) => { updateSetting({ 'player.isFadeIn': v }) }} />
      <View style={styles.offsetRow}>
        <Text size={12} color={theme['c-font-label']}>{'定时退出前渐弱  ' + (timeoutFade > 0 ? timeoutFade + 's' : '关闭')}</Text>
        <View style={styles.offsetBtns}>
          <OffsetBtn text="-5s" onPress={() => { updateSetting({ 'player.timeoutExitFade': Math.max(0, timeoutFade - 5) }) }} />
          <OffsetBtn text="+5s" onPress={() => { updateSetting({ 'player.timeoutExitFade': Math.min(60, timeoutFade + 5) }) }} />
          <OffsetBtn text="关闭" onPress={() => { updateSetting({ 'player.timeoutExitFade': 0 }) }} />
        </View>
      </View>
      <CheckBoxItem check={gestureEnable} label={t('setting_play_gesture')} onChange={(v: boolean) => { updateSetting({ 'playDetail.gestureEnable': v }) }} />
    </SubTitle>
  )
})

const styles = createStyle({
  offsetRow: {
    marginBottom: 8,
  },
  offsetBtns: {
    flexDirection: 'row',
    marginTop: 6,
  },
  offsetBtn: {
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 6,
    paddingBottom: 6,
    borderRadius: 8,
    marginRight: 8,
  },
})
