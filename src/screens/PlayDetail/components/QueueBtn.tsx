import { memo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'

import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useTempPlayList } from '@/store/player/hook'
import QueuePanel, { type QueuePanelType } from './QueuePanel'
import { createStyle } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT as _HEADER_HEIGHT } from '@/config/constant'

const HEADER_HEIGHT = scaleSizeH(_HEADER_HEIGHT)

/**
 * 播放页的播放队列入口
 */
export default memo(() => {
  const theme = useTheme()
  const panelRef = useRef<QueuePanelType>(null)
  const list = useTempPlayList()

  return (
    <>
      <TouchableOpacity onPress={() => { panelRef.current?.show() }} style={styles.button}>
        <View style={styles.content}>
          <Icon name="menu" size={18} color={theme['c-font-label']} />
          {list.length ? <Text size={9} color={theme['c-font-label']} style={styles.count}>{list.length}</Text> : null}
        </View>
      </TouchableOpacity>
      <QueuePanel ref={panelRef} />
    </>
  )
})

const styles = createStyle({
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
    flex: 0,
    minWidth: HEADER_HEIGHT,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  count: {
    marginLeft: 1,
  },
})
