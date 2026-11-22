import { memo } from 'react'
import { TouchableOpacity } from 'react-native'

import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'

export default memo(({ label, active, onPress }: {
  label: string
  active: boolean
  onPress: () => void
}) => {
  const theme = useTheme()

  return (
    <TouchableOpacity
      style={{ ...styles.item, backgroundColor: active ? theme['c-primary-alpha-400'] : theme['c-primary-alpha-100'] }}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text size={12} color={active ? theme['c-primary-font'] : theme['c-font-label']}>{label}</Text>
    </TouchableOpacity>
  )
})

const styles = createStyle({
  item: {
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 7,
    paddingBottom: 7,
    borderRadius: 16,
    marginRight: 8,
    marginBottom: 8,
  },
})
