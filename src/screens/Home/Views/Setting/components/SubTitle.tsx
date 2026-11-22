import { memo } from 'react'

import { View } from 'react-native'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'

export default memo(({ title, children }: {
  title: string
  children: React.ReactNode | React.ReactNode[]
}) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title} size={13}>{title}</Text>
      {children}
    </View>
  )
})


const styles = createStyle({
  container: {
    marginTop: 10,
    paddingTop: 12,
    marginBottom: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(127,127,127,0.16)',
  },
  title: {
    marginBottom: 8,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
})
