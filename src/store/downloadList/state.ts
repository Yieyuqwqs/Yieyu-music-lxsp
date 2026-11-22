export interface InitState {
  list: LX.Download.ListItem[]
  /** 当前解析出来的下载保存目录 */
  saveDir: string
}

const state: InitState = {
  list: [],
  saveDir: '',
}

export default state
