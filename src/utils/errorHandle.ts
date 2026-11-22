import { Alert } from 'react-native'
// import { exitApp } from '@/utils/common'
import { setJSExceptionHandler, setNativeExceptionHandler } from 'react-native-exception-handler'
import { log } from '@/utils/log'
import { toast } from './tools'
import RNFS from 'react-native-fs'

const CRASH_LOG_PATHS = [
  '/storage/emulated/0/Download/lxmusic-crash.log',
  `${RNFS.ExternalDirectoryPath}/lxmusic-crash.log`,
]
const appendCrashLog = (message: string) => {
  const text = `\n===== ${new Date().toISOString()} =====\n${message}\n`
  void (async() => {
    for (const path of CRASH_LOG_PATHS) {
      try {
        await RNFS.appendFile(path, text, 'utf8')
        return
      } catch {}
    }
  })()
}

const errorHandler = (e: Error, isFatal: boolean) => {
  const excludedErrors = [
    'Failed to construct \'Response\'',
  ]
  if (isFatal) {
    if (excludedErrors.some((excludedError) => e.message.includes(excludedError))) {
      toast('应用遇到了错误，如果你有固定的复现方式，请截图并在 GitHub 反馈（并附上具体的操作步骤，以及“设置-错误日志”的内容）')
    } else {
      Alert.alert(
        '💥Unexpected error occurred💥',
        `
  应用出 bug 了😭，以下是错误异常信息。请截图并在 GitHub 反馈（并附上刚才你进行了什么操作，以及附上“设置-错误日志”的内容）。现在应用可能会出现异常，若出现异常请尝试强制结束应用后重新启动！

  Error:
  ${isFatal ? 'Fatal:' : ''} ${e.name} ${e.message}
  `,
        [{
          text: '关闭 (Close)',
          onPress: () => {
            // exitApp()
          },
        }],
      )
    }
  }
  log.error(e.stack)
  appendCrashLog(`[global] ${e?.stack ?? e?.message ?? 'unknown'}`)
}

if (process.env.NODE_ENV !== 'development') {
  setJSExceptionHandler(errorHandler)

  setNativeExceptionHandler((errorString) => {
    log.error(errorString)
    appendCrashLog(`[native] ${errorString}`)
    console.log('+++++', errorString, '+++++')
  }, false)
}
