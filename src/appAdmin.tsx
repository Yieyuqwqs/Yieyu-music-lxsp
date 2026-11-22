// 管理端入口：只用 react-native 原生组件，不加载任何业务模块/主题上下文
import { Component, type ReactNode } from 'react'
import { Navigation } from 'react-native-navigation'
import { ScrollView, Text, View } from 'react-native'
import AdminApp from '@/screens/AdminApp'

const COMPONENT_ID = 'YieyuAdmin'

/** 兜底：任何渲染异常都显示出来，方便排查，而不是直接闪退 */
class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }

  static getDerivedStateFromError (error: Error) {
    return { error: String(error?.message ?? error) }
  }

  componentDidCatch (error: Error) {
    console.error('[YieyuAdmin] render error', error)
  }

  render () {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: '#14161a', padding: 24 }}>
          <ScrollView>
            <Text style={{ color: '#ff6b6b', fontSize: 16, fontWeight: '700' }}>管理端启动失败</Text>
            <Text selectable style={{ color: '#c9d1d9', fontSize: 12, marginTop: 12 }}>
              {this.state.error}
            </Text>
          </ScrollView>
        </View>
      )
    }
    return this.props.children
  }
}

Navigation.registerComponent(COMPONENT_ID, () => () => <Boundary><AdminApp /></Boundary>)

Navigation.events().registerAppLaunchedListener(() => {
  Navigation.setRoot({
    root: {
      component: {
        name: COMPONENT_ID,
        options: {
          topBar: { visible: false },
          statusBar: { style: 'light', backgroundColor: '#14161a' },
          layout: { componentBackgroundColor: '#14161a' },
        },
      },
    },
  }).catch(() => {})
})
