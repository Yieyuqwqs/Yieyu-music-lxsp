import { useCallback, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { SETTING_MODULES } from '../modules'
import { type SettingScreenIds } from '../Main'

/**
 * 横向模式左侧导航：按四大模块折叠，模块名做分组标题
 */
export default ({ onChangeId }: {
  onChangeId: (id: SettingScreenIds) => void
}) => {
  const theme = useTheme()
  const t = useI18n()
  const [activeId, setActiveId] = useState<SettingScreenIds>(global.lx.settingActiveId)

  const handleChangeId = useCallback((id: SettingScreenIds) => {
    onChangeId(id)
    setActiveId(id)
    global.lx.settingActiveId = id
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps={'always'}>
      {SETTING_MODULES.map(module => (
        <View key={module.id} style={styles.group}>
          <Text size={10} style={styles.groupTitle} color={theme['c-500']} numberOfLines={1}>
            {t(module.titleKey)}
          </Text>
          {module.entries.map(entry => {
            const active = activeId === entry.id
            return (
              <TouchableOpacity
                key={entry.id}
                style={[styles.item, active && { backgroundColor: theme['c-primary-alpha-900'] }]}
                onPress={() => handleChangeId(entry.id)}
                activeOpacity={0.6}
              >
                <Text
                  size={13}
                  numberOfLines={1}
                  color={active ? theme['c-primary-font'] : theme['c-font']}
                >{t(`setting_${entry.id}`)}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      ))}
    </ScrollView>
  )
}

const styles = createStyle({
  container: {
    flexGrow: 0,
    flexShrink: 1,
  },
  content: {
    paddingTop: 10,
    paddingBottom: 16,
    paddingLeft: 10,
    paddingRight: 10,
  },
  group: {
    marginBottom: 12,
  },
  groupTitle: {
    paddingLeft: 6,
    paddingBottom: 5,
    letterSpacing: 0.4,
    opacity: 0.55,
  },
  item: {
    height: 34,
    justifyContent: 'center',
    paddingLeft: 10,
    paddingRight: 10,
    borderRadius: 10,
    marginBottom: 2,
  },
})
