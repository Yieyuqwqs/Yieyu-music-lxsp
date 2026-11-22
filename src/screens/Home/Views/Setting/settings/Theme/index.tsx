import { memo } from 'react'

// import Section from '../../components/Section'
import Theme from './Theme'
import IsAutoTheme from './IsAutoTheme'
import IsHideBgDark from './IsHideBgDark'
import IsDynamicBg from './IsDynamicBg'
import CustomBg from './CustomBg'
import CustomPrimary from './CustomPrimary'
import LyricColor from './LyricColor'
import BgAdjust from './BgAdjust'
import SkinPack from './SkinPack'
import IsFontShadow from './IsFontShadow'
// import { useI18n } from '@/lang/i18n'

export default memo(() => {
  return (
    <>
      <Theme />
      <IsAutoTheme />
      <IsHideBgDark />
      <IsDynamicBg />
      <CustomPrimary />
      <LyricColor />
      <BgAdjust />
      <SkinPack />
      <CustomBg />
      <IsFontShadow />
    </>
  )
})
