// import './app_setting'

declare namespace LX {
  type OnlineSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg'
  type Source = OnlineSource | 'local'
  type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | '192k' | 'ape' | 'wav'
  /** 扩展音质档位：臻品全景声 / 全景声+ / 臻品母带（需要音源支持） */
  type QualityLevel = Quality | 'atmos' | 'atmos_plus' | 'master'
  /** 音质设置：具体档位或自动（最高可用） */
  type QualitySetting = QualityLevel | 'auto'
  type QualityList = Partial<Record<LX.Source, LX.Quality[]>>

  type ShareType = 'system' | 'clipboard'

  type UpdateStatus = 'downloaded' | 'downloading' | 'error' | 'checking' | 'idle'
  interface VersionInfo {
    version: string
    desc: string
  }
}
