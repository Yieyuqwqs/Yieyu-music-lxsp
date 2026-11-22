// import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import ImageBackground from '@/components/common/ImageBackground'
import { useWindowSize } from '@/utils/hooks'
import { useEffect, useMemo, useRef } from 'react'
import { Animated, Easing } from 'react-native'
import { scaleSizeAbsHR } from '@/utils/pixelRatio'
import { defaultHeaders } from './common/Image'
import SizeView from './SizeView'
import { useBgPic } from '@/store/common/hook'
import { useSettingValue } from '@/store/setting/hook'

interface Props {
  children: React.ReactNode
}

const BLUR_RADIUS = Math.max(scaleSizeAbsHR(18), 10)

const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground)

export default ({ children }: Props) => {
  const theme = useTheme()
  const windowSize = useWindowSize()
  const pic = useBgPic()
  const blurRadius = useSettingValue('theme.bgBlur')
  const bgDark = useSettingValue('theme.bgDark')
  const bgSpeed = useSettingValue('theme.bgSpeed')
  const powerSaveMode = useSettingValue('common.powerSaveMode')
  const animationDuration = Math.max(2000, Math.round(12000 / Math.max(0.2, bgSpeed ?? 1)))
  const scaleAnim = useRef(new Animated.Value(1)).current

  // 背景图片缓慢缩放（动态背景 / 自定义背景）
  useEffect(() => {
    if (!pic || powerSaveMode) return
    scaleAnim.setValue(1)
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 1.08, duration: animationDuration, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
      Animated.timing(scaleAnim, { toValue: 1, duration: animationDuration, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
    ]))
    animation.start()
    return () => {
      animation.stop()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pic, animationDuration, powerSaveMode])
  // const [wh, setWH] = useState<{ width: number | string, height: number | string }>({ width: '100%', height: Dimensions.get('screen').height })

  // 固定宽高度 防止弹窗键盘时大小改变导致背景被缩放
  // useEffect(() => {
  //   const onChange = () => {
  //     setWH({ width: '100%', height: '100%' })
  //   }

  //   const changeEvent = Dimensions.addEventListener('change', onChange)
  //   return () => {
  //     changeEvent.remove()
  //   }
  // }, [])
  // const handleLayout = (e: LayoutChangeEvent) => {
  //   // console.log('handleLayout', e.nativeEvent)
  //   // console.log(Dimensions.get('screen'))
  //   setWH({ width: e.nativeEvent.layout.width, height: Dimensions.get('screen').height })
  // }
  // console.log('render page content')

  const themeComponent = useMemo(() => (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      <ImageBackground
        style={{ position: 'absolute', left: 0, top: 0, height: windowSize.height, width: windowSize.width, backgroundColor: theme['c-content-background'] }}
        source={theme['bg-image']}
        resizeMode="cover"
      >
      </ImageBackground>
      <View style={{ flex: 1, flexDirection: 'column', backgroundColor: theme['c-main-background'] }}>
        {children}
      </View>
    </View>
  ), [children, theme, windowSize.height, windowSize.width])
  const picComponent = useMemo(() => {
    return (
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <AnimatedImageBackground
          style={{ position: 'absolute', left: 0, top: 0, height: windowSize.height, width: windowSize.width, backgroundColor: theme['c-content-background'], transform: [{ scale: scaleAnim }] }}
          source={{ uri: pic!, headers: defaultHeaders }}
          resizeMode="cover"
          blurRadius={powerSaveMode ? 0 : (blurRadius ?? BLUR_RADIUS)}
        >
          <View style={{ flex: 1, flexDirection: 'column', backgroundColor: theme['c-content-background'], opacity: Math.min(1, Math.max(0, (bgDark ?? 76) / 100)) }}></View>
        </AnimatedImageBackground>
        <View style={{ flex: 1, flexDirection: 'column' }}>
          {children}
        </View>
      </View>
    )
  }, [children, pic, theme, windowSize.height, windowSize.width])

  return (
    <>
      <SizeView />
      {pic ? picComponent : themeComponent}
    </>
  )
}
