import { memo, useCallback } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { useBackHandler } from '@/utils/hooks/useBackHandler'
import { SettingContent, type SettingScreenIds } from '../Main'
import { getModuleOfScreen } from '../modules'

export default memo(({ id, onBack }: { id: SettingScreenIds, onBack: () => void }) => {
  const theme = useTheme()
  const t = useI18n()
  const module = getModuleOfScreen(id)

  useBackHandler(useCallback(() => {
    onBack()
    return true
  }, [onBack]))

  return (
    <View style={styles.container}>
      <View style={[styles.header, { borderBottomColor: theme['c-border-background'] }]}>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.6}>
          <Icon name="chevron-left" color={theme['c-font']} size={16} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text size={15} style={styles.headerTitle} numberOfLines={1}>{t(`setting_${id}`)}</Text>
          {module ? <Text size={10} style={styles.headerSub} color={theme['c-500']}>{t(module.titleKey)}</Text> : null}
        </View>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.6}>
          <Text size={11} color={theme['c-500']}>{t('back')}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps={'always'}
      >
        <SettingContent id={id} />
      </ScrollView>
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    paddingLeft: 6,
    paddingRight: 12,
    borderBottomWidth: 1,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    paddingLeft: 2,
  },
  headerTitle: {
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  headerSub: {
    paddingTop: 2,
    letterSpacing: 0.2,
    opacity: 0.6,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 14,
    paddingBottom: 28,
  },
})
