import { memo } from 'react'
import { ScrollView, View } from 'react-native'

import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import ModuleCard from '../components/ModuleCard'
import { SETTING_MODULES } from '../modules'
import { type SettingScreenIds } from '../Main'

export default memo(({ onSelect }: { onSelect: (id: SettingScreenIds) => void }) => {
  const theme = useTheme()
  const t = useI18n()
  const versionName = (typeof process !== 'undefined' && process.versions?.app) || ''

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps={'always'}
    >
      <View style={styles.hero}>
        <Text size={22} style={styles.heroTitle} color={theme['c-font']}>Aurora</Text>
        <Text size={11} style={styles.heroSub} color={theme['c-500']}>
          {t('setting_module_subtitle')}
        </Text>
      </View>

      {SETTING_MODULES.map(module => (
        <ModuleCard key={module.id} module={module} onSelect={onSelect} />
      ))}

      <Text size={10} style={styles.footer} color={theme['c-500']}>
        {versionName ? `Yieyu Music · v${versionName} · Final` : 'Yieyu Music · Final'}
      </Text>
    </ScrollView>
  )
})

const styles = createStyle({
  scroll: {
    flex: 1,
  },
  content: {
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 28,
  },
  hero: {
    paddingLeft: 2,
    paddingBottom: 16,
  },
  heroTitle: {
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  heroSub: {
    paddingTop: 5,
    letterSpacing: 0.3,
  },
  footer: {
    textAlign: 'center',
    paddingTop: 4,
    letterSpacing: 0.6,
    opacity: 0.6,
  },
})
