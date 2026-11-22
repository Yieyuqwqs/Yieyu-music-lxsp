import { Platform, PermissionsAndroid } from 'react-native'
import RNFS from 'react-native-fs'

import {
  downloadFile,
  stopDownload,
  existsFile,
  moveFile,
  temporaryDirectoryPath,
  unlink,
  writeFile,
} from '@/utils/fs'
import { getMusicUrl as getOnlineMusicUrl, getLyricInfo as getOnlineLyricInfo, getPicUrl as getOnlinePicUrl } from '@/core/music/online'
import downloadAction, { bindCacheInvalidator } from '@/store/downloadList/action'
import downloadState from '@/store/downloadList/state'
import settingState from '@/store/setting/state'
import { getDownloadList, saveDownloadList, getDownloadSaveDir, saveDownloadSaveDir } from '@/utils/data'
import { writeLyric, writePic } from '@/utils/localMediaMetadata'
import { buildFileName, getDownloadQualityList, getExtFromUrl, getTaskId, sanitizeFileName } from './utils'
import { startDownloadService, stopDownloadService } from '@/utils/nativeModules/downloadService'

/** 默认下载目录（系统公共音乐目录） */
const DEFAULT_SAVE_DIR = '/storage/emulated/0/Music/Yieyu Music'

interface JobInfo {
  jobId: number
  stopped: boolean
}

bindCacheInvalidator(() => { invalidateDownloadedCache() })

const jobMap = new Map<string, JobInfo>()
let saveDir = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null

const t = (key: string, params?: Record<string, string | number | boolean>): string => {
  return (global.i18n?.t as ((key: string, params?: Record<string, string | number | boolean>) => string) | undefined)?.(key, params) ?? key
}

/**
 * 逐级创建目录
 */
const ensureDir = async(dir: string) => {
  const parts = dir.split('/').filter(Boolean)
  let path = ''
  for (const part of parts) {
    path += `/${part}`
    try {
      if (!(await RNFS.exists(path))) await RNFS.mkdir(path)
    } catch {}
  }
}

const isDirWritable = async(dir: string) => {
  try {
    await ensureDir(dir)
    const testPath = `${dir}/.lx_download_test`
    await RNFS.writeFile(testPath, 'ok', 'utf8')
    await RNFS.unlink(testPath).catch(() => {})
    return true
  } catch {
    return false
  }
}

const requestStoragePermission = async() => {
  if (Platform.OS != 'android') return true
  try {
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE
    if (await PermissionsAndroid.check(permission)) return true
    const result = await PermissionsAndroid.request(permission)
    return result == PermissionsAndroid.RESULTS.GRANTED
  } catch {
    return false
  }
}

export const getSaveDir = async(): Promise<string> => {
  if (saveDir) return saveDir
  const customDir = (settingState.setting['download.savePath'] ?? '').trim()
  if (customDir) {
    if (await isDirWritable(customDir)) {
      saveDir = customDir
      downloadAction.setSaveDir(customDir)
      return customDir
    }
  }
  const lastSaveDir = await getDownloadSaveDir().catch(() => '')
  const externalPath = RNFS.ExternalDirectoryPath
  const candidates: string[] = []
  if (lastSaveDir) candidates.push(lastSaveDir)
  candidates.push(DEFAULT_SAVE_DIR)
  candidates.push(`${externalPath}/Music`)
  candidates.push(`${externalPath}/Download`)
  await requestStoragePermission()
  for (const dir of candidates) {
    if (!(await isDirWritable(dir))) continue
    saveDir = dir
    downloadAction.setSaveDir(dir)
    if (dir != lastSaveDir) void saveDownloadSaveDir(dir)
    return dir
  }
  saveDir = `${RNFS.DocumentDirectoryPath}/Music`
  await ensureDir(saveDir)
  downloadAction.setSaveDir(saveDir)
  void saveDownloadSaveDir(saveDir)
  return saveDir
}

/**
 * 保存下载列表（节流）
 */
const saveList = () => {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveDownloadList(downloadState.list.map(item => ({
      ...item,
      speed: '',
      metadata: { ...item.metadata },
    }))).catch(() => {})
  }, 800)
}

const saveListNow = async() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    await saveDownloadList(downloadState.list.map(item => ({
      ...item,
      speed: '',
      metadata: { ...item.metadata },
    })))
  } catch {}
}

const resolveTaskUrl = async(task: LX.Download.ListItem): Promise<{ url: string, quality: LX.QualityLevel }> => {
  const musicInfo = task.metadata.musicInfo
  const qualitys = getDownloadQualityList(musicInfo, task.qualitySetting ?? settingState.setting['download.quality'])
  for (const quality of qualitys) {
    try {
      const url = await getOnlineMusicUrl({ musicInfo, quality: quality as LX.QualitySetting, isRefresh: true })
      return { url, quality }
    } catch {}
  }
  const url = await getOnlineMusicUrl({ musicInfo, isRefresh: true })
  return { url, quality: qualitys[qualitys.length - 1] ?? '128k' }
}

/**
 * 下载完成后写入歌词文件
 */
const saveLyricFile = async(filePath: string, musicInfo: LX.Music.MusicInfoOnline) => {
  try {
    const lyricInfo = await getOnlineLyricInfo({ musicInfo, isRefresh: false })
    const lyric = lyricInfo?.lyric
    if (!lyric) return
    const lrcPath = filePath.replace(/\.[^.]+$/, '.lrc')
    const header = `[ti:${musicInfo.name}]\n[ar:${musicInfo.singer}]\n[al:${musicInfo.meta?.albumName ?? ''}]\n`
    await writeFile(lrcPath, `${header}${lyric}`, 'utf8')
    // 同时写入文件内嵌歌词
    void writeLyric(filePath, `${header}${lyric}`).catch(() => {})
  } catch {}
}

const runningSet = new Set<string>()

const getMaxThreads = () => settingState.setting['common.powerSaveMode'] ? 1 : Math.max(1, Math.min(3, settingState.setting['download.maxThreads'] ?? 1))

/**
 * 把封面写入音频文件内嵌标签，并缓存读取结果
 */
const picCache = new Map<string, string>()
let picBackfillSet = new Set<string>()

const embedCover = async(filePath: string, task: LX.Download.ListItem) => {
  try {
    const musicInfo = task.metadata.musicInfo
    let picUrl = musicInfo.meta?.picUrl ?? ''
    if (!picUrl) picUrl = await getOnlinePicUrl({ musicInfo, isRefresh: false }).catch(() => '')
    if (!picUrl) return
    if (musicInfo.meta) musicInfo.meta.picUrl = picUrl
    const tempPic = `${temporaryDirectoryPath}/dl-cover-${task.id.replace(/[^\w.-]/g, '_')}.jpg`
    const { promise } = downloadFile(picUrl, tempPic, {
      connectionTimeout: 20000,
      readTimeout: 30000,
    })
    await promise.catch(() => {})
    try {
      // 把封面写入歌曲文件的内嵌标签
      await writePic(filePath, tempPic)
      // 内嵌成功后清理旧的同名 jpg
      await unlink(filePath.replace(/\.[^.]+$/, '.jpg')).catch(() => {})
      picCache.delete(filePath)
    } catch {}
    await unlink(tempPic).catch(() => {})
    saveList()
  } catch {}
}

const startNextTask = () => {
  const maxThreads = getMaxThreads()
  while (runningSet.size < maxThreads) {
    const nextTask = downloadState.list.find(task => task.status == 'waiting' && !runningSet.has(task.id))
    if (!nextTask) return
    runningSet.add(nextTask.id)
    startDownloadService()
    void runTask(nextTask).finally(() => {
      runningSet.delete(nextTask.id)
      if (!runningSet.size && !downloadState.list.some(task => task.status == 'waiting')) {
        stopDownloadService()
      }
      startNextTask()
    })
  }
}

const runTask = async(task: LX.Download.ListItem) => {
  const taskId = task.id
  downloadAction.updateTask(taskId, {
    status: 'run',
    statusText: t('download_status_run'),
    speed: '',
    downloaded: 0,
    total: 0,
    progress: 0,
  })
  try {
    const { url, quality } = await resolveTaskUrl(task)
    if (!url) throw new Error(t('download_get_url_failed'))
    if (task.status != 'run') return
    task.metadata.url = url
    task.metadata.quality = quality
    const ext = getExtFromUrl(url, quality)
    task.metadata.ext = ext
    if (!task.metadata.fileName) {
      task.metadata.fileName = buildFileName(task.metadata.musicInfo, ext, settingState.setting['download.fileName'])
    }
    let dir = await getSaveDir()
    if (settingState.setting['download.folderStructure']) {
      dir = dir + '/' + sanitizeFileName(task.metadata.musicInfo.singer || '未知歌手')
      await ensureDir(dir)
    }
    if (task.status != 'run') return
    const filePath = `${dir}/${task.metadata.fileName}`
    task.metadata.filePath = filePath
    const tempPath = `${filePath}.lxdtmp`
    await RNFS.unlink(tempPath).catch(() => {})

    let lastBytes = 0
    let lastTime = Date.now()
    let lastUpdateAt = 0
    const job = downloadFile(url, tempPath, {
      progressInterval: 500,
      connectionTimeout: 20000,
      readTimeout: 30000,
      begin: ({ contentLength }) => {
        task.total = contentLength > 0 ? contentLength : 0
        downloadAction.updateTask(taskId, { total: task.total })
      },
      progress: ({ contentLength, bytesWritten }) => {
        const now = Date.now()
        const totalBytes = contentLength > 0 ? contentLength : task.total
        const percent = totalBytes > 0 ? Math.min(Math.round(bytesWritten / totalBytes * 100), 99) : 0
        if (percent == task.progress && now - lastUpdateAt < 1000) return
        const duration = (now - lastTime) / 1000
        let speed = 0
        if (duration > 0) speed = (bytesWritten - lastBytes) / duration
        lastBytes = bytesWritten
        lastTime = now
        lastUpdateAt = now
        const total = contentLength > 0 ? contentLength : task.total
        downloadAction.updateTask(taskId, {
          total,
          downloaded: bytesWritten,
          progress: total > 0 ? Math.min(Math.round(bytesWritten / total * 100), 99) : 0,
          speed: speed > 0 ? `${(speed / 1024).toFixed(0)}KB/s` : '',
        })
      },
    })
    jobMap.set(taskId, { jobId: job.jobId, stopped: false })
    await job.promise
    jobMap.delete(taskId)

    if (task.status != 'run') return

    const fileStat = await RNFS.stat(tempPath).catch(() => null)
    if (!fileStat || Number(fileStat.size) <= 0) throw new Error(t('download_empty_file_tip'))
    await RNFS.unlink(filePath).catch(() => {})
    try {
      await moveFile(tempPath, filePath)
    } catch {
      await RNFS.moveFile(tempPath, filePath)
    }
    const fileSize = Number(fileStat.size)
    downloadAction.updateTask(taskId, {
      status: 'completed',
      retryAttempt: 0,
      isComplate: true,
      statusText: t('download_status_completed'),
      speed: '',
      progress: 100,
      total: fileSize,
      downloaded: fileSize,
    })
    void embedCover(filePath, task)
    void saveLyricFile(filePath, task.metadata.musicInfo)
  } catch (err) {
    jobMap.delete(taskId)
    if (task.status == 'run') {
      const message = (err as Error)?.message
      const maxRetry = Math.max(0, Math.min(5, settingState.setting['download.retryCount'] ?? 0))
      const retryAttempt = task.retryAttempt ?? 0
      if (retryAttempt < maxRetry) {
        downloadAction.updateTask(taskId, {
          status: 'waiting',
          retryAttempt: retryAttempt + 1,
          statusText: t('download_status_retry', { num: retryAttempt + 1 }),
          downloaded: 0,
          progress: 0,
          speed: '',
        })
      } else {
        downloadAction.updateTask(taskId, {
          status: 'error',
          statusText: message && message != 'Failed to download file' ? message : t('download_status_error'),
          speed: '',
        })
      }
    }
  } finally {
    saveList()
  }
}

/**
 * 添加下载任务
 * @param musicInfos 歌曲列表
 * @param qualitySetting 指定音质（不传则使用全局设置）
 */
export const addTasks = async(musicInfos: LX.Music.MusicInfoOnline[], qualitySetting?: LX.QualitySetting): Promise<{ added: number, skip: number }> => {
  const tasks: LX.Download.ListItem[] = []
  let skip = 0
  for (const musicInfo of musicInfos) {
    const id = getTaskId(musicInfo)
    const existTask = downloadAction.getTask(id)
    if (existTask) {
      if (existTask.status == 'error' || existTask.status == 'pause') {
        downloadAction.updateTask(id, {
          status: 'waiting',
          statusText: t('download_status_waiting'),
          progress: 0,
          downloaded: 0,
          speed: '',
          qualitySetting,
        })
      } else {
        skip++
      }
      continue
    }
    tasks.push({
      id,
      isComplate: false,
      status: 'waiting',
      statusText: t('download_status_waiting'),
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      qualitySetting,
      metadata: {
        musicInfo: {
          ...musicInfo,
          meta: { ...musicInfo.meta },
        } as LX.Music.MusicInfoOnline,
        url: null,
        quality: '128k',
        ext: 'mp3',
        fileName: '',
        filePath: '',
      },
    })
  }
  if (tasks.length) {
    downloadAction.addTasks(tasks)
    saveList()
    startNextTask()
  }
  return { added: tasks.length, skip }
}

/**
 * 暂停任务
 */
export const pauseTask = (id: string) => {
  const task = downloadAction.getTask(id)
  if (!task) return
  if (task.status == 'completed') return
  if (task.status == 'run') {
    const job = jobMap.get(id)
    if (job) {
      job.stopped = true
      try {
        stopDownload(job.jobId)
      } catch {}
      jobMap.delete(id)
    }
  }
  if (task.metadata.filePath) {
    void RNFS.unlink(`${task.metadata.filePath}.lxdtmp`).catch(() => {})
  }
  downloadAction.updateTask(id, {
    status: 'pause',
    statusText: t('download_status_pause'),
    speed: '',
  })
  saveList()
}

/**
 * 继续任务
 */
export const resumeTask = (id: string) => {
  const task = downloadAction.getTask(id)
  if (!task || task.status == 'completed' || task.status == 'run') return
  downloadAction.updateTask(id, {
    status: 'waiting',
    statusText: t('download_status_waiting'),
    downloaded: 0,
    total: 0,
    progress: 0,
    speed: '',
  })
  saveList()
  startNextTask()
}

/**
 * 全部开始
 */
export const startAllTasks = () => {
  const ids = downloadState.list.filter(task => task.status != 'completed' && task.status != 'run').map(task => task.id)
  if (!ids.length) return
  downloadAction.updateTasks(ids, {
    status: 'waiting',
    statusText: t('download_status_waiting'),
    speed: '',
  })
  saveList()
  startNextTask()
}

/**
 * 全部暂停
 */
export const pauseAllTasks = () => {
  for (const task of [...downloadState.list]) {
    if (task.status == 'run' || task.status == 'waiting') pauseTask(task.id)
  }
}

/**
 * 删除任务
 * @param ids 任务id
 * @param isDeleteFile 是否同时删除已下载的文件
 */
export const removeTasks = async(ids: string[], isDeleteFile = false) => {
  const files: string[] = []
  for (const id of ids) {
    const task = downloadAction.getTask(id)
    if (!task) continue
    if (task.status == 'run') pauseTask(id)
    if (!isDeleteFile || !task.metadata.filePath) continue
    files.push(task.metadata.filePath)
  }
  downloadAction.removeTasks(ids)
  await saveListNow()
  for (const filePath of files) {
    await unlink(filePath).catch(() => {})
    await unlink(filePath.replace(/\.[^.]+$/, '.lrc')).catch(() => {})
  }
}

/**
 * 清空已完成的任务（不删除文件）
 */
export const clearCompletedTasks = async() => {
  downloadAction.clearCompleted()
  await saveListNow()
}

/**
 * 重试失败的任务
 */
export const retryTask = (id: string) => {
  const task = downloadAction.getTask(id)
  if (!task || task.status != 'error') return
  downloadAction.updateTask(id, {
    status: 'waiting',
    statusText: t('download_status_waiting'),
    downloaded: 0,
    total: 0,
    progress: 0,
    speed: '',
  })
  saveList()
  startNextTask()
}

/**
 * 获取歌曲已下载的文件路径
 */
export const getDownloadedFilePath = async(musicInfo: LX.Music.MusicInfo): Promise<string> => {
  const id = getTaskId(musicInfo)
  const task = downloadState.list.find(item => item.id == id)
  if (!task || task.status != 'completed' || !task.metadata.filePath) return ''
  try {
    if (await existsFile(task.metadata.filePath)) return task.metadata.filePath
  } catch {}
  return ''
}

/**
 * 获取已下载歌曲的本地封面路径
 */
export const getDownloadedPicPath = async(musicInfo: LX.Music.MusicInfo): Promise<string> => {
  const id = getTaskId(musicInfo)
  const task = downloadState.list.find(item => item.id == id)
  if (!task || task.status != 'completed' || !task.metadata.filePath) return ''
  const picPath = task.metadata.filePath.replace(/\.[^.]+$/, '.jpg')
  try {
    if (await existsFile(picPath)) return `file://${picPath}`
  } catch {}
  // 老版本下载的文件没有封面，后台补一张
  if (!picBackfillSet.has(task.id)) {
    picBackfillSet.add(task.id)
    void embedCover(task.metadata.filePath, task)
  }
  return ''
}

/**
 * 任务是否已下载完成
 */
let completedIdCache: Set<string> | null = null

/**
 * 下载状态变化后调用，使已下载缓存失效
 */
export const invalidateDownloadedCache = () => {
  completedIdCache = null
}

const getCompletedIds = () => {
  if (!completedIdCache) {
    completedIdCache = new Set(downloadState.list.filter(item => item.status == 'completed').map(item => item.id))
  }
  return completedIdCache
}

export const isDownloaded = (musicInfo: LX.Music.MusicInfo): boolean => {
  return getCompletedIds().has(getTaskId(musicInfo))
}

/**
 * 初始化下载模块
 */
export const init = async() => {
  const list = await getDownloadList().catch(() => [])
  if (!list.length) return
  const tasks: LX.Download.ListItem[] = []
  for (const item of list) {
    if (!item?.metadata?.musicInfo) continue
    tasks.push({
      ...item,
      speed: '',
      statusText: item.status == 'completed'
        ? t('download_status_completed')
        : item.status == 'error'
          ? t('download_status_error')
          : t('download_status_pause'),
      status: item.status == 'run' || item.status == 'waiting' ? 'pause' : item.status,
      downloaded: 0,
      progress: item.status == 'completed' ? 100 : 0,
    })
  }
  downloadAction.setList(tasks)
}
