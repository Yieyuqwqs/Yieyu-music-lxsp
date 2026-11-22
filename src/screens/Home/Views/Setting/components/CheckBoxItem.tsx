import { memo } from 'react'

import { View } from 'react-native'

import CheckBox, { type CheckBoxProps } from '@/components/common/CheckBox'
import { createStyle } from '@/utils/tools'


export default memo((props: CheckBoxProps) => {
  return (
    <View style={styles.container}>
      <CheckBox {...props} />
    </View>
  )
})

const styles = createStyle({
  container: {
    // 统一由 Section 卡片给左边距，行与行之间只留最小呼吸感
    paddingTop: 2,
    paddingBottom: 2,
    minHeight: 34,
    justifyContent: 'center',
  },
})
