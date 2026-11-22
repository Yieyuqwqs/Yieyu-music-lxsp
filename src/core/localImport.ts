import { scanAudioFiles } from '@/utils/localMediaMetadata'
import { createUserList, addListMusics } from '@/core/list'
import { buildLocalMusicInfoByFilePath } from '@/screens/Home/Views/Mylist/MyList/listAction'
import { expandCueInFolder } from '@/core/cue'

/**
 * 扫描指定目录下的音频文件并导入为一个新的「本地音乐」歌单。
 * 目录里有 .cue 时按 CUE 展开成虚拟曲目，被 CUE 覆盖的整轨音频不再单独入列表。
 */
export const importLocalMusicFolder = async(dirPath: string): Promise<number> => {
  const files = await scanAudioFiles(dirPath)
  const cue = await expandCueInFolder(dirPath).catch(() => ({ infos: [], covered: [], failed: [] }))
  const covered = new Set(cue.covered)
  const plainFiles = files.filter(file => !covered.has(file.path))
  const infos = [
    ...plainFiles.map(file => buildLocalMusicInfoByFilePath(file)),
    ...cue.infos,
  ]
  if (!infos.length) return 0
  const id = `local_${Date.now()}`
  const name = `本地音乐 ${new Date().getMonth() + 1}/${new Date().getDate()}`
  await createUserList(0, [{ id, name, locationUpdateTime: Date.now() }])
  await addListMusics(id, infos, 'bottom')
  return infos.length
}
