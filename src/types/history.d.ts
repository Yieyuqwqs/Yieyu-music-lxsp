declare namespace LX {
  interface PlayHistoryItem {
    time: number
    listId: string
    musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  }
}
