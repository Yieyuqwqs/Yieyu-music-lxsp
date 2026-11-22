import { memo } from 'react'
import { View } from 'react-native'

import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'

/**
 * 播放页底部版权信息（始终水平居中）
 */
export default memo(() => {
  const theme = useTheme()

  return (
    <View style={styles.container}>
      <Text size={11} color="rgba(255,255,255,0.4)" style={styles.text}>2023-2026 Copyright©Yieyu</Text>
    </View>
  )
})

const styles = createStyle({
  container: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 2,
    paddingBottom: 5,
  },
  text: {
    textAlign: 'center',
    opacity: 0.5,
  },
})
