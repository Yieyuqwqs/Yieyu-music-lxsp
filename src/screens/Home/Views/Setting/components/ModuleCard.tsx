import { memo } from 'react'
import { TouchableOpacity, View } from 'react-native'

import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { type SettingModule } from '../modules'
import { type SettingScreenIds } from '../Main'

interface Props {
  module: SettingModule
  onSelect: (id: SettingScreenIds) => void
}

/**
 * 20dp 毛玻璃模块卡：深/浅主题都吃同一套中性玻璃材质
 * 标题 16 / 描述 11 / 行标题 14 / 行描述 11，全部左对齐同一条基线
 */
export default memo(({ module, onSelect }: Props) => {
  const theme = useTheme()
  const t = useI18n()

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: module.accent + '22', borderColor: module.accent + '55' }]}>
          <Icon name={module.icon} color={module.accent} size={16} />
        </View>
        <View style={styles.headText}>
          <Text size={16} style={styles.title}>{t(module.titleKey)}</Text>
          <Text size={11} numberOfLines={1} style={styles.desc}>{t(module.descKey)}</Text>
        </View>
      </View>

      <View style={styles.body}>
        {module.entries.map(entry => (
          <TouchableOpacity
            key={entry.id}
            style={styles.row}
            activeOpacity={0.55}
            onPress={() => onSelect(entry.id)}
          >
            <View style={styles.rowIconBox}>
              <Icon name={entry.icon} color={theme['c-font']} size={14} />
            </View>
            <View style={styles.rowText}>
              <Text size={14} numberOfLines={1}>{t(`setting_${entry.id}`)}</Text>
              <Text size={11} numberOfLines={1} style={styles.rowDesc}>{t(entry.descKey)}</Text>
            </View>
            <Icon name="chevron-right" color={theme['c-500']} size={12} />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  )
})

const styles = createStyle({
  card: {
    marginBottom: 18,
    padding: 16,
    borderRadius: 20,
    backgroundColor: 'rgba(127,127,127,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.16)',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  badge: {
    width: 34,
    height: 34,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: {
    flex: 1,
    paddingLeft: 11,
  },
  title: {
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  desc: {
    paddingTop: 3,
    opacity: 0.55,
    letterSpacing: 0.2,
  },
  body: {
    flexDirection: 'column',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 10,
  },
  rowIconBox: {
    width: 26,
    height: 26,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  rowText: {
    flex: 1,
    paddingLeft: 11,
    paddingRight: 8,
  },
  rowDesc: {
    paddingTop: 2,
    opacity: 0.5,
    letterSpacing: 0.2,
  },
})
