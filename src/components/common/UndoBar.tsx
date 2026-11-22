import { memo, useEffect, useRef, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import Text from './Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { useStatusbarHeight } from '@/store/common/hook'

/**
 * 底部撤销提示条
 */
export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const statusBarHeight = useStatusbarHeight()
  const [message, setMessage] = useState<string | null>(null)
  const handlerRef = useRef<(() => void) | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const handleShow = (text: string, handler: () => void) => {
      setMessage(text)
      handlerRef.current = handler
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        setMessage(null)
        handlerRef.current = null
      }, 4000)
    }
    global.app_event.on('showUndoMsg', handleShow)
    return () => {
      global.app_event.off('showUndoMsg', handleShow)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleUndo = () => {
    setMessage(null)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    handlerRef.current?.()
    handlerRef.current = null
  }

  if (!message) return null

  return (
    <View style={{ ...styles.container, bottom: statusBarHeight + 96, backgroundColor: theme['c-primary-dark-200-alpha-300'] }}>
      <Text size={12} color={theme['c-font']} style={styles.text} numberOfLines={1}>{message}</Text>
      <TouchableOpacity onPress={handleUndo} style={styles.btn}>
        <Text size={12} color={theme['c-primary-font']}>{t('undo')}</Text>
      </TouchableOpacity>
    </View>
  )
})

const styles = createStyle({
  container: {
    position: 'absolute',
    left: 30,
    right: 30,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingLeft: 16,
    paddingRight: 8,
    paddingTop: 8,
    paddingBottom: 8,
    elevation: 6,
  },
  text: {
    flex: 1,
  },
  btn: {
    paddingLeft: 12,
    paddingRight: 8,
    paddingTop: 2,
    paddingBottom: 2,
  },
})
