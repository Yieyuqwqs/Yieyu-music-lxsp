import * as React from 'react'
import {
  Animated,
  type GestureResponderEvent,
  View,
  Pressable,
} from 'react-native'


export interface Props {
  /**
   * Status of checkbox.
   */
  status: 'checked' | 'unchecked' | 'indeterminate'
  /**
   * Whether checkbox is disabled.
   */
  disabled?: boolean
  /**
   * Function to execute on press.
   */
  onPress?: (e: GestureResponderEvent) => void

  size?: number

  /**
   * Custom color for checkbox.
   */
  tintColors: {
    true: string
    false: string
  }
}

const ANIMATION_DURATION = 200

/**
 * Checkboxes allow the selection of multiple options from a set.
 * This component follows platform guidelines for Android, but can be used
 * on any platform.
 */
const Checkbox = ({
  status,
  disabled,
  size = 1,
  onPress,
  tintColors,
  ...rest
}: Props) => {
  const checked = status === 'checked'
  const indeterminate = status === 'indeterminate'

  const icon = indeterminate
    ? 'minus-box'
    : 'checkbox-marked'

  const { current: scaleAnim } = React.useRef<Animated.Value>(
    new Animated.Value(checked ? 1 : 0),
  )

  const isFirstRendering = React.useRef<boolean>(true)


  React.useEffect(() => {
    // Do not run animation on very first rendering
    if (isFirstRendering.current) {
      isFirstRendering.current = false
      return
    }

    Animated.timing(scaleAnim, {
      toValue: checked ? 1 : 0,
      duration: ANIMATION_DURATION,
      useNativeDriver: true,
    }).start()
  }, [checked, scaleAnim])


  const trackWidth = 42 * size
  const trackHeight = 24 * size
  const knobSize = 18 * size
  const travel = trackWidth - knobSize - 6
  const translateX = scaleAnim.interpolate({ inputRange: [0, 1], outputRange: [0, travel] })

  return (
    <Pressable
      {...rest}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ disabled, checked }}
      accessibilityLiveRegion="polite"
      style={{ marginVertical: 2 }}
    >
      <View
        style={{
          width: trackWidth,
          height: trackHeight,
          borderRadius: trackHeight / 2,
          backgroundColor: checked || indeterminate ? tintColors.true : 'rgba(128,128,128,0.35)',
          justifyContent: 'center',
          paddingHorizontal: 3,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Animated.View
          style={{
            width: knobSize,
            height: knobSize,
            borderRadius: knobSize / 2,
            backgroundColor: '#ffffff',
            transform: [{ translateX }],
            shadowColor: '#000',
            shadowOpacity: 0.2,
            shadowRadius: 3,
            elevation: 2,
          }}
        />
      </View>
    </Pressable>
  )
}

Checkbox.displayName = 'Checkbox'


export default Checkbox

