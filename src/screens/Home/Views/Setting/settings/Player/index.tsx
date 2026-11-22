import { memo } from 'react'

import Section from '../../components/Section'
import SoundEffectButton from '@/components/SoundEffectButton'
import IsSavePlayTime from './IsSavePlayTime'
import PlayHighQuality from './PlayHighQuality'
import PlayExperience from './PlayExperience'
import IsHandleAudioFocus from './IsHandleAudioFocus'
import IsEnableAudioOffload from './IsEnableAudioOffload'
import IsAutoCleanPlayedList from './IsAutoCleanPlayedList'
import IsShowBluetoothLyric from './IsShowBluetoothLyric'
import IsShowBluetoothFullLyric from './IsShowBluetoothFullLyric'
import IsShowNotificationImage from './IsShowNotificationImage'
import IsShowVisualizer from './IsShowVisualizer'
import IsShowLyricTranslation from './IsShowLyricTranslation'
import IsShowLyricRoma from './IsShowLyricRoma'
import IsS2T from './IsS2T'
import MaxCache from './MaxCache'
import { useI18n } from '@/lang'


export default memo(() => {
  const t = useI18n()

  return (
    <Section title={t('setting_player')}>
      <SoundEffectButton />
      <IsSavePlayTime />
      <IsAutoCleanPlayedList />
      <IsHandleAudioFocus />
      <IsEnableAudioOffload />
      <IsShowBluetoothLyric />
      <IsShowBluetoothFullLyric />
      <IsShowNotificationImage />
      <IsShowVisualizer />
      <IsShowLyricTranslation />
      <IsShowLyricRoma />
      <IsS2T />
      <MaxCache />
      <PlayHighQuality />
      <PlayExperience />
    </Section>
  )
})
