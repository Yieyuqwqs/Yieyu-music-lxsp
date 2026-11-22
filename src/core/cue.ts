import { NativeModules } from 'react-native'

import { extname, mkdir, readDir, readFile } from '@/utils/fs'
import { readMetadata } from '@/utils/localMediaMetadata'
import { parseCueText, resolveCueRanges, type CueSheet, type CueTrackRange } from '@/utils/cueSheet'
import { formatPlayTime2 } from '@/utils'

const AUDIO_EXTS = ['flac', 'ape', 'wav', 'mp3', 'm4a', 'ogg', 'aac', 'wv', 'tak', 'dsf']

interface CueBridge {
  exportTrack: (inputPath: string, startSec: number, endSec: number, outputPath: string) => Promise<{ path: string, bytes: number, seconds: number }>
  probe?: (inputPath: string) => Promise<{ supported: boolean, mime?: string, sampleRate?: number, channels?: number, duration?: number, error?: string }>
}

export const cueNative = NativeModules.CueExportModule as CueBridge | undefined

/** GBK 系 CUE 的解码兜底：UTF-8 解出替换字符时再按 gb18030 试一次 */
const decodeBuffer = (buffer: Buffer): string => {
  const utf8 = buffer.toString('utf-8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const iconv = require('iconv-lite') as { decode: (buf: Buffer, encoding: string) => string }
    const gb = iconv.decode(buffer, 'gb18030')
    if (gb && !gb.includes('\uFFFD')) return gb
  } catch {}
  return utf8
}

const stripBom = (text: string) => text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text

const isBase64 = (text: string) => text.length > 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(text)

/** 读 CUE：优先拿二进制（好做 GBK 兜底），拿不到就按文本读 */
export const readCueSheets = async(cuePath: string): Promise<CueSheet[]> => {
  let text = ''
  try {
    const raw = await readFile(cuePath, 'base64' as never) as unknown as string
    if (typeof raw === 'string' && isBase64(raw)) {
      text = decodeBuffer(Buffer.from(raw.replace(/\s/g, ''), 'base64'))
    }
  } catch {}
  if (text === '') {
    try {
      text = stripBom(String(await readFile(cuePath) ?? ''))
    } catch {
      return []
    }
  }
  return parseCueText(text)
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

const resolveAudioPath = (dirPath: string, cuePath: string, sheet: CueSheet, entries: { name: string, path: string }[]): string | null => {
  const audioEntries = entries.filter(entry => AUDIO_EXTS.includes(extname(entry.name).toLowerCase()))
  const declared = sheet.file.trim()
  if (declared !== '') {
    const wanted = baseName(declared).toLowerCase()
    const hit = audioEntries.find(entry => entry.name.toLowerCase() === wanted)
    if (hit) return hit.path
  }
  // 没写 FILE（或名字对不上）：同名 / 唯一音频文件兜底
  const cueName = baseName(cuePath).replace(/\.cue$/i, '').toLowerCase()
  const sameName = audioEntries.find(entry => entry.name.replace(/\.[^.]+$/, '').toLowerCase() === cueName)
  if (sameName) return sameName.path
  if (audioEntries.length === 1) return audioEntries[0].path
  if (audioEntries.length > 1) {
    const prefix = audioEntries.find(entry => entry.name.toLowerCase().startsWith(cueName) || cueName.startsWith(entry.name.replace(/\.[^.]+$/, '').toLowerCase()))
    if (prefix) return prefix.path
  }
  return null
}

export interface CueExpandResult {
  infos: LX.Music.MusicInfoLocal[]
  /** 已经被 CUE 展开覆盖的整轨音频路径：这些文件不能再单独入歌单 */
  covered: string[]
  /** 解析失败/找不到音轨的 CUE */
  failed: string[]
}

export const buildCueMusicInfos = (
  cuePath: string,
  sheet: CueSheet,
  audioPath: string,
  duration: number,
): LX.Music.MusicInfoLocal[] => {
  const ranges: CueTrackRange[] = resolveCueRanges(sheet, duration)
  const album = sheet.title || baseName(audioPath).replace(/\.[^.]+$/, '')
  const albumSinger = sheet.performer || ''
  const ext = extname(audioPath)
  return ranges.map((track, index) => {
    const no = track.no || index + 1
    const name = track.title || `${album} - ${String(no).padStart(2, '0')}`
    return {
      id: `${audioPath}#cue${no}`,
      name,
      singer: track.performer || albumSinger,
      source: 'local',
      interval: formatPlayTime2(Math.max(1, Math.round(track.end - track.start))),
      meta: {
        albumName: album,
        filePath: audioPath,
        songId: audioPath,
        picUrl: '',
        ext,
        cue: {
          start: track.start,
          end: track.end,
          trackNo: no,
          cuePath,
        },
      },
    }
  })
}

/** 扫目录里的 .cue，展开成虚拟曲目 */
export const expandCueInFolder = async(dirPath: string): Promise<CueExpandResult> => {
  const result: CueExpandResult = { infos: [], covered: [], failed: [] }
  let entries: { name: string, path: string }[] = []
  try {
    const files = await readDir(dirPath)
    entries = files
      .filter(file => file.isFile !== false)
      .map(file => ({ name: file.name, path: file.path ?? `${dirPath}/${file.name}` }))
  } catch {
    return result
  }
  const cueFiles = entries.filter(entry => extname(entry.name).toLowerCase() === 'cue')
  if (!cueFiles.length) return result

  for (const cueFile of cueFiles) {
    const sheets = await readCueSheets(cueFile.path).catch(() => [] as CueSheet[])
    if (!sheets.length) {
      result.failed.push(cueFile.path)
      continue
    }
    let matched = false
    for (const sheet of sheets) {
      const audioPath = resolveAudioPath(dirPath, cueFile.path, sheet, entries)
      if (audioPath == null) continue
      let duration = 0
      try {
        const metadata = await readMetadata(audioPath)
        duration = metadata?.interval ?? 0
      } catch {}
      if (!(duration > 0)) {
        // 读不到时长就退回系统解码器探测
        const probed = await cueNative?.probe?.(audioPath).catch(() => null)
        if (probed?.supported && probed.duration) duration = probed.duration
      }
      const infos = buildCueMusicInfos(cueFile.path, sheet, audioPath, duration)
      if (!infos.length) continue
      matched = true
      result.infos.push(...infos)
      if (!result.covered.includes(audioPath)) result.covered.push(audioPath)
    }
    if (!matched) result.failed.push(cueFile.path)
  }
  return result
}

/** 目录里的 .cue 列表（给 UI 用） */
export const findCueFiles = async(dirPath: string): Promise<string[]> => {
  const files = await readDir(dirPath).catch(() => [])
  return files
    .filter(file => extname(file.name).toLowerCase() === 'cue')
    .map(file => file.path ?? `${dirPath}/${file.name}`)
}

export const formatCueList = (cuePath: string): string => baseName(cuePath)

const sanitizeFileName = (name: string) => (name || '未命名')
  .replace(/[\\/:*?"<>|]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80) || '未命名'

export interface CueExportFile {
  path: string
  name: string
}

export interface CueExportOptions {
  outputDir: string
  onProgress?: (done: number, total: number, label: string) => void
}

export const DEFAULT_CUE_EXPORT_DIR = '/sdcard/Download/Yieyu-CUE'

/**
 * 真切片导出：MediaExtractor + MediaCodec 解码后按 INDEX 裁好，写成 WAV（无损 PCM）。
 * 返回导出的文件列表；失败的曲目会带错误信息返回。
 */
export const exportCueSheet = async(cuePath: string, options: CueExportOptions): Promise<{ files: CueExportFile[], errors: string[] }> => {
  const files: CueExportFile[] = []
  const errors: string[] = []
  if (!cueNative?.exportTrack) {
    return { files, errors: ['当前版本不含切片导出模块'] }
  }
  const dirPath = cuePath.replace(/[\\/][^\\/]+$/, '')
  const entries: { name: string, path: string }[] = []
  try {
    const dirFiles = await readDir(dirPath)
    for (const file of dirFiles) entries.push({ name: file.name, path: file.path ?? `${dirPath}/${file.name}` })
  } catch {}
  const sheets = await readCueSheets(cuePath)
  if (!sheets.length) return { files, errors: ['CUE 解析失败'] }

  const albumDir = `${options.outputDir}/${sanitizeFileName(baseName(cuePath).replace(/\.cue$/i, ''))}`
  await mkdir(albumDir).catch(() => {})

  let total = 0
  const plans: { audioPath: string, album: string, tracks: CueTrackRange[] }[] = []
  for (const sheet of sheets) {
    const audioPath = resolveAudioPath(dirPath, cuePath, sheet, entries)
    if (audioPath == null) {
      errors.push(`${sheet.file || '未知音轨'}：目录里找不到对应音频`)
      continue
    }
    let duration = 0
    try {
      duration = (await readMetadata(audioPath))?.interval ?? 0
    } catch {}
    if (!(duration > 0)) {
      const probed = await cueNative.probe?.(audioPath).catch(() => null)
      if (probed?.supported && probed.duration) duration = probed.duration
    }
    const ranges = resolveCueRanges(sheet, duration)
    if (!ranges.length) continue
    plans.push({ audioPath, album: sheet.title || baseName(audioPath).replace(/\.[^.]+$/, ''), tracks: ranges })
    total += ranges.length
  }

  let done = 0
  for (const plan of plans) {
    for (let index = 0; index < plan.tracks.length; index++) {
      const track = plan.tracks[index]
      const no = String(track.no || index + 1).padStart(2, '0')
      const title = sanitizeFileName(track.title || `${plan.album} - ${no}`)
      const outputPath = `${albumDir}/${no} ${title}.wav`
      options.onProgress?.(done, total, `${no} ${title}`)
      try {
        await cueNative.exportTrack(plan.audioPath, track.start, track.end, outputPath)
        files.push({ path: outputPath, name: `${no} ${title}.wav` })
      } catch (error) {
        errors.push(`${no} ${title}：${(error as Error)?.message ?? '导出失败'}`)
      }
      done++
      options.onProgress?.(done, total, `${no} ${title}`)
    }
  }
  return { files, errors }
}
