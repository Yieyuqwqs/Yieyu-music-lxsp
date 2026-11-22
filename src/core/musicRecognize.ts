import { PermissionsAndroid, Platform } from 'react-native'

import { recordAudio } from '@/utils/nativeModules/recognize'
import { hmacSha1 } from '@/utils/hmacSha1'
import settingState from '@/store/setting/state'

export interface RecognizeResult {
  title: string
  artists: string
  album: string
  releaseDate?: string
  playOffsetMs?: number
}

const RECORD_DURATION = 8000

const getCredentials = () => {
  const host = (settingState.setting['recognize.acrHost'] ?? '').trim()
  const key = (settingState.setting['recognize.acrKey'] ?? '').trim()
  const secret = (settingState.setting['recognize.acrSecret'] ?? '').trim()
  return { host, key, secret }
}

const requestPermission = async() => {
  if (Platform.OS != 'android') return true
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
    return result == PermissionsAndroid.RESULTS.GRANTED
  } catch {
    return false
  }
}

/**
 * 听歌识曲：录音 8 秒后调用 ACRCloud 识别
 */
export const recognizeSong = async(): Promise<RecognizeResult> => {
  const { host, key, secret } = getCredentials()
  if (!host || !key || !secret) throw new Error(global.i18n.t('recognize_need_config'))
  if (!await requestPermission()) throw new Error(global.i18n.t('recognize_permission_denied'))

  const sample = await recordAudio(RECORD_DURATION)
  if (!sample) throw new Error(global.i18n.t('recognize_failed'))

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const stringToSign = ['POST', '/v1/identify', key, 'audio', '1', timestamp].join('\n')
  const signature = Buffer.from(hmacSha1(Buffer.from(secret, 'utf8'), Buffer.from(stringToSign, 'utf8'))).toString('base64')

  const body = [
    `access_key=${encodeURIComponent(key)}`,
    'data_type=audio',
    'signature_version=1',
    `timestamp=${timestamp}`,
    `signature=${encodeURIComponent(signature)}`,
    `sample=${encodeURIComponent(sample)}`,
  ].join('&')

  const res = await fetch(`https://${host}/v1/identify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`识别失败（HTTP ${res.status}）`)
  const data = await res.json() as any
  const music = data?.metadata?.music?.[0]
  if (!music) throw new Error(global.i18n.t('recognize_no_result'))
  return {
    title: music.title ?? '',
    artists: (music.artists ?? []).map((item: any) => item.name).filter(Boolean).join('、'),
    album: music.album?.name ?? '',
    releaseDate: music.release_date ?? '',
    playOffsetMs: music.play_offset_ms,
  }
}
