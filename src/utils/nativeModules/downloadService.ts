import { NativeModules } from 'react-native'

const { DownloadService } = NativeModules

export const startDownloadService = () => {
  try {
    DownloadService?.start()
  } catch {}
}

export const stopDownloadService = () => {
  try {
    DownloadService?.stop()
  } catch {}
}
