import { getListMusics, createUserList, addListMusics } from '@/core/list'
import settingState from '@/store/setting/state'
import listState from '@/store/list/state'
import { AES_MODE, aesDecrypt, aesEncrypt } from '@/utils/nativeModules/crypto'
import { updateSetting } from './common'

const KEY = 'lxmusic_yieyu_01'
const DEFAULT_VI = 'lxmusic_backup01'

const randomVi = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let text = ''
  for (let i = 0; i < 16; i++) text += chars[Math.floor(Math.random() * chars.length)]
  return text
}

export interface EncryptedBackupData {
  version: number
  time: number
  setting: Partial<LX.AppSetting>
  lists: Array<{ name: string, musics: LX.Music.MusicInfo[] }>
}

const buildBackupData = async(): Promise<EncryptedBackupData> => {
  const lists: EncryptedBackupData['lists'] = []
  for (const info of listState.userList) {
    const musics = await getListMusics(info.id).catch(() => [])
    lists.push({ name: info.name, musics })
  }
  return {
    version: 1,
    time: Date.now(),
    setting: { ...settingState.setting },
    lists,
  }
}

/**
 * 生成加密备份内容（AES）
 */
export const exportEncryptedBackup = async(): Promise<string> => {
  const data = await buildBackupData()
  const vi = randomVi()
  const encrypted = await aesEncrypt(JSON.stringify(data), KEY, vi, AES_MODE.CBC_128_PKCS7Padding)
  return `${vi}:${encrypted}`
}

/**
 * 导入加密备份内容
 */
export const importEncryptedBackup = async(content: string): Promise<number> => {
  const raw = content.replace(/\s+/g, '')
  const separatorIndex = raw.indexOf(':')
  const vi = separatorIndex > 0 && separatorIndex <= 32 ? raw.slice(0, separatorIndex) : DEFAULT_VI
  const encrypted = separatorIndex > 0 && separatorIndex <= 32 ? raw.slice(separatorIndex + 1) : raw
  const text = await aesDecrypt(encrypted, KEY, vi, AES_MODE.CBC_128_PKCS7Padding)
  const data = JSON.parse(text) as EncryptedBackupData
  if (!data || typeof data.version != 'number') throw new Error('invalid backup')
  if (data.setting) updateSetting(data.setting)
  let count = 0
  for (const list of data.lists ?? []) {
    if (!list?.musics?.length) continue
    const id = `restored_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
    await createUserList(0, [{ id, name: list.name || '恢复的歌单', locationUpdateTime: Date.now() }])
    await addListMusics(id, list.musics, 'bottom')
    count++
  }
  return count
}
