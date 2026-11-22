import { View } from 'react-native'

import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'


interface Props {
  title: string
  children: React.ReactNode | React.ReactNode[]
}

export default ({ title, children }: Props) => {
  const theme = useTheme()

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={[styles.accent, { backgroundColor: theme['c-primary'] }]} />
        <Text style={styles.title} size={15}>{title}</Text>
      </View>
      <View style={styles.body}>
        {children}
      </View>
    </View>
  )
}


const styles = createStyle({
  container: {
    marginBottom: 14,
    paddingTop: 16,
    paddingBottom: 8,
    paddingLeft: 16,
    paddingRight: 16,
    borderRadius: 20,
    // 中性灰玻璃：深浅主题都能用，和「实验室」里的 Hi-Res / CUE 卡片同一套材质
    backgroundColor: 'rgba(127,127,127,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.16)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  accent: {
    width: 3,
    height: 14,
    borderRadius: 2,
    marginRight: 9,
  },
  title: {
    flexShrink: 1,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  body: {
    // 子项统一从卡片内边距开始排，不再各自 paddingLeft: 25
  },
})
