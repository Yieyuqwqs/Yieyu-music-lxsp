import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ScrollView, Text, TouchableOpacity, View } from 'react-native'

import RNFS from 'react-native-fs'

const LOG_PATHS = [
  '/storage/emulated/0/Download/lxmusic-crash.log',
  `${RNFS.ExternalDirectoryPath}/lxmusic-crash.log`,
]

const writeCrashLog = async(message: string) => {
  const text = `\n===== ${new Date().toISOString()} =====\n${message}\n`
  for (const path of LOG_PATHS) {
    try {
      await RNFS.appendFile(path, text, 'utf8')
      return
    } catch {}
  }
}

interface Props {
  children: ReactNode
  name?: string
}

interface State {
  error: Error | null
  info: string
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }
  prevErrorUtils: any = null

  constructor(props: Props) {
    super(props)
    this.prevErrorUtils = (global as any).ErrorUtils?.getGlobalHandler?.()
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const message = `[${this.props.name ?? 'component'}] ${error?.stack ?? error?.message ?? 'unknown'}\n${info?.componentStack ?? ''}`
    console.log(message)
    void writeCrashLog(message)
    this.setState({ error, info: info?.componentStack ?? '' })
  }

  handleRetry = () => {
    this.setState({ error: null, info: '' })
  }

  render() {
    if (!this.state.error) return this.props.children
    const err = this.state.error
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: '#1b1b1b' }}>
        <Text style={{ color: '#ff7676', fontSize: 15, fontWeight: 'bold' }}>出错了（{this.props.name ?? '未知页面'}）</Text>
        <ScrollView style={{ flex: 1, marginTop: 10, marginBottom: 10 }}>
          <Text selectable style={{ color: '#eee', fontSize: 11 }}>
            {`${err?.message ?? ''}\n\n${err?.stack ?? ''}\n\n${this.state.info}`}
          </Text>
        </ScrollView>
        <TouchableOpacity onPress={this.handleRetry} style={{ paddingVertical: 12, alignItems: 'center', backgroundColor: '#3a3a3a', borderRadius: 8 }}>
          <Text style={{ color: '#fff', fontSize: 14 }}>重试 / Retry</Text>
        </TouchableOpacity>
      </View>
    )
  }
}
