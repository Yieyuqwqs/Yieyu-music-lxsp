import { memo, useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'

import { usePlayerMusicInfo } from '@/store/player/hook'

/**
 * 播放页沉浸式背景：当前封面全屏 + 重度模糊 + 黑色遮罩
 */
export default memo(() => {
  const musicInfo = usePlayerMusicInfo()
  const [pic, setPic] = useState(musicInfo.pic)

  useEffect(() => {
    if (musicInfo.pic) setPic(musicInfo.pic)
  }, [musicInfo.pic])

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1b1b1f' }]} />
      {
        pic
          ? <Image
              source={{ uri: pic }}
              style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.6 }] }]}
              blurRadius={80}
              resizeMode="cover"
            />
          : null
      }
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.42)' }]} />
    </View>
  )
})

