import type { I18n } from '@/lang/i18n'

declare global {
  namespace LX {
    type AddMusicLocationType = 'top' | 'bottom'

    interface AppSetting {
      version: string
      /**
       * 是否跟随系统切换亮暗主题
       */
      'common.isAutoTheme': boolean

      /**
       * 语言id
       */
      'common.langId': I18n['locale'] | null

      /**
       * 当前生效的音源标识：'lxsp' 表示统一音源引擎；其余为历史脚本 id（已停用）
       */
      'common.apiSource': string

      /**
       * LXSP 端点列表：换行或逗号分隔，支持 url|token 内联写法
       * 例：http://127.0.0.1:1101 或 https://gw.example.com|lxsp_xxx
       */
      'common.lxspEndpoints': string

      /**
       * LXSP 全局令牌（Authorization: Bearer）；为空表示端点不鉴权
       */
      'common.lxspToken': string

      /**
       * 通用 API 源配置（JSON 数组字符串）：地址 + 密钥 + 请求模板 + 提取规则
       * 填了就能把任意解析服务器当音源用
       */
      'common.customSources': string


      /**
       * 音源名称类型，原名、别名
       */
      'common.sourceNameType': 'alias' | 'real'

      /**
       * 歌曲分享方式
       */
      'common.shareType': 'system' | 'clipboard'

      /**
       * 是否同意软件协议
       */
      'common.isAgreePact': boolean

      /**
       * 是否在键盘弹出时隐藏播放栏
       */
      'common.autoHidePlayBar': boolean

      /**
       * 抽屉组件弹出方向
       */
      'common.drawerLayoutPosition': 'left' | 'right'

      /**
       * 启用首页滑动
       */
      'common.homePageScroll': boolean

      /**
       * 允许通过底栏进度条调整进度
       */
      'common.allowProgressBarSeek': boolean

      /**
       * 是否显示返回按钮
       */
      'common.showBackBtn': boolean

      /**
       * 是否显示退出按钮
       */
      'common.showExitBtn': boolean

      /**
       * 使用系统文件选择器
       */
      'common.useSystemFileSelector': boolean

      /**
       * 总是保留状态栏高度
       */
      'common.alwaysKeepStatusbarHeight': boolean

      /**
       * 主题id
       */
      'theme.id': string

      /**
       * 亮色主题id
       */
      'theme.lightId': string

      /**
       * 暗色主题id
       */
      'theme.darkId': string

      /**
       * 隐藏黑色主题背景
       */
      'theme.hideBgDark': boolean

      /**
       * 动态背景
       */
      'theme.dynamicBg': boolean

      /**
       * 自定义背景图片路径，空字符串为不使用
       */
      'theme.customBgPic': string

      /**
       * 字体阴影
       */
      'theme.fontShadow': boolean

      /**
       * 自定义主色（空字符串表示使用主题自带主色）
       */
      'theme.customPrimary': string

      /**
       * 背景模糊程度
       */
      'theme.bgBlur': number

      /**
       * 背景暗度（0-100）
       */
      'theme.bgDark': number

      /**
       * 背景动效速度倍率
       */
      'theme.bgSpeed': number

      /**
       * 下载并发数
       */
      'download.maxThreads': number

      /**
       * 下载失败重试次数
       */
      'download.retryCount': number

      /**
       * 歌词偏移（毫秒）
       */
      'playDetail.lrcOffset': number

      /**
       * 是否启用逐字歌词
       */
      'playDetail.isShowWordLyric': boolean

      /**
       * 自定义歌词颜色（空字符串 = 自动对比度：亮底黑字 / 暗底白字）
       */
      'playDetail.lyricColor': string

      /**
       * 蓝牙模式自动优化（连上蓝牙耳机时自动关掉 Hi-Res 升频 / audio offload）
       */
      'bt.autoMode': boolean

      /**
       * 蓝牙歌词延迟补偿（毫秒，正值表示「歌词延后」这么多毫秒；AAC/SBC 建议 150~200）
       */
      'bt.lyricCompensation': number

      /**
       * 是否启用播放页手势
       */
      'playDetail.gestureEnable': boolean

      /**
       * 是否启用唱片旋转动画
       */
      'playDetail.isDiscRotate': boolean

      /**
       * 省电模式（降低动效与并发）
       */
      'common.powerSaveMode': boolean

      /**
       * 下载时按歌手建文件夹
       */
      'download.folderStructure': boolean

      /**
       * 自定义下载目录（空字符串表示自动探测）
       */
      'download.savePath': string

      /**
       * ACRCloud 识别服务器 Host
       */
      'recognize.acrHost': string

      /**
       * ACRCloud access_key
       */
      'recognize.acrKey': string

      /**
       * ACRCloud access_secret
       */
      'recognize.acrSecret': string


      /**
       * 电台模式：歌单播完后自动续播相似歌曲
       */
      'player.radioMode': boolean

      /**
       * 播放时音量淡入
       */
      'player.isFadeIn': boolean
      'player.timeoutExitFade': number
      'player.hapticBass.enable': boolean
      'player.hapticBass.strength': number

      /**
       * 启动时自动播放歌曲
       */
      'player.startupAutoPlay': boolean

      /**
       * 启动后打开歌曲详细界面
       */
      'player.startupPushPlayDetailScreen': boolean

      /**
       * 切歌模式
       */
      'player.togglePlayMethod': 'listLoop' | 'random' | 'list' | 'singleLoop' | 'none'

      /**
       * 优先播放的音质
       */
      'player.playQuality': LX.QualitySetting

      /**
       * 启动软件时是否恢复上次播放进度
       */
      'player.isSavePlayTime': boolean

      /**
       * 音量大小
       */
      'player.volume': number

      /**
       * 播放页是否显示音频可视化背景
       */
      'player.visualizer.enable': boolean

      'player.soundEffect.equalizer.enable': boolean
      'player.soundEffect.biquadFilter.hz31': number
      'player.soundEffect.biquadFilter.hz62': number
      'player.soundEffect.biquadFilter.hz125': number
      'player.soundEffect.biquadFilter.hz250': number
      'player.soundEffect.biquadFilter.hz500': number
      'player.soundEffect.biquadFilter.hz1000': number
      'player.soundEffect.biquadFilter.hz2000': number
      'player.soundEffect.biquadFilter.hz4000': number
      'player.soundEffect.biquadFilter.hz8000': number
      'player.soundEffect.biquadFilter.hz16000': number
      /** 均衡段数：10（老十段）/ 31（三分之一倍频程） */
      'player.soundEffect.equalizer.mode': number
      /** 自动预衰减：正增益超过 +6dB 的部分抵掉，防止叠加增益把限幅器压爆 */
      'player.soundEffect.equalizer.headroom': boolean
      /** Aurora-29：模拟黑胶 / 胆机 —— 总开关 */
      'player.soundEffect.vinyl.enable': boolean
      /** 味精加量 0..100（0 = 完全直通） */
      'player.soundEffect.vinyl.amount': number
      /** 胆机软削波（偶次谐波，让声音变暖） */
      'player.soundEffect.vinyl.tube': boolean
      /** 黑胶底噪（嘶声 + 随机颗粒） */
      'player.soundEffect.vinyl.noise': boolean
      /** Wow & Flutter（唱片转速轻微不稳） */
      'player.soundEffect.vinyl.wow': boolean
      /** true = 4 倍过采样（高保真），false = 2 倍（省电） */
      'player.soundEffect.vinyl.hifi': boolean
      /** Aurora-30：16kHz 陡峭低通（蓝牙防高频毛刺，默认开） */
      'player.soundEffect.vinyl.lpf': boolean
      'player.soundEffect.biquadFilter31.hz20': number
      'player.soundEffect.biquadFilter31.hz25': number
      'player.soundEffect.biquadFilter31.hz31.5': number
      'player.soundEffect.biquadFilter31.hz40': number
      'player.soundEffect.biquadFilter31.hz50': number
      'player.soundEffect.biquadFilter31.hz63': number
      'player.soundEffect.biquadFilter31.hz80': number
      'player.soundEffect.biquadFilter31.hz100': number
      'player.soundEffect.biquadFilter31.hz125': number
      'player.soundEffect.biquadFilter31.hz160': number
      'player.soundEffect.biquadFilter31.hz200': number
      'player.soundEffect.biquadFilter31.hz250': number
      'player.soundEffect.biquadFilter31.hz315': number
      'player.soundEffect.biquadFilter31.hz400': number
      'player.soundEffect.biquadFilter31.hz500': number
      'player.soundEffect.biquadFilter31.hz630': number
      'player.soundEffect.biquadFilter31.hz800': number
      'player.soundEffect.biquadFilter31.hz1000': number
      'player.soundEffect.biquadFilter31.hz1250': number
      'player.soundEffect.biquadFilter31.hz1600': number
      'player.soundEffect.biquadFilter31.hz2000': number
      'player.soundEffect.biquadFilter31.hz2500': number
      'player.soundEffect.biquadFilter31.hz3150': number
      'player.soundEffect.biquadFilter31.hz4000': number
      'player.soundEffect.biquadFilter31.hz5000': number
      'player.soundEffect.biquadFilter31.hz6300': number
      'player.soundEffect.biquadFilter31.hz8000': number
      'player.soundEffect.biquadFilter31.hz10000': number
      'player.soundEffect.biquadFilter31.hz12500': number
      'player.soundEffect.biquadFilter31.hz16000': number
      'player.soundEffect.biquadFilter31.hz20000': number
      'player.soundEffect.convolution.fileName': string
      'player.soundEffect.convolution.mainGain': number
      'player.soundEffect.convolution.sendGain': number
      'player.soundEffect.surround.mode': number
      'player.soundEffect.surround.strength': number
      'player.soundEffect.surround.speed': number
      'player.soundEffect.headTrack.enable': boolean
      'player.soundEffect.presets': string

      /**
       * 极客功能：本地插值升频（C++ 多相 sinc 重采样到 96/192kHz）
       */
      'player.hires.enable': boolean
      /**
       * 升频目标采样率：192000 / 96000 / 48000
       */
      'player.hires.target': number

      /**
       * 播放速率
       */
      'player.playbackRate': number

      /**
       * 缓存大小设置 unit MiB
       */
      'player.cacheSize': string

      /**
       * 定时暂停播放-倒计时时间
       */
      'player.timeoutExit': string

      /**
       * 定时暂停播放-是否等待歌曲播放完毕再暂停
       */
      'player.timeoutExitPlayed': boolean

      /**
       * 点击相同列表内的歌曲切歌时是否清空已播放列表（随机模式下列表内所有歌曲会重新参与随机）
       */
      'player.isAutoCleanPlayedList': boolean

      /**
       * 其他应用播放声音时是否自动暂停
       */
      'player.isHandleAudioFocus': boolean

      /**
       * 是否启用音频卸载功能（这可以节省耗电量，没有播放异常问题不建议关闭）
       */
      'player.isEnableAudioOffload': boolean

      /**
       * 是否显示歌词翻译
       */
      'player.isShowLyricTranslation': boolean

      /**
       * 是否显示歌词罗马音
       */
      'player.isShowLyricRoma': boolean

      /**
       * 是否在通知栏显示歌曲图片
       */
      'player.isShowNotificationImage': boolean

      /**
       * 是否将歌词从简体转换为繁体
       */
      'player.isS2t': boolean

      /**
       * 是否启用蓝牙歌词
       */
      'player.isShowBluetoothLyric': boolean

      /**
       * 是否启用蓝牙完整歌词
       */
      'player.isShowBluetoothFullLyric': boolean

      /**
       * 播放详情页-是否缩放当前播放的歌词行
       */
      // 'playDetail.isZoomActiveLrc': boolean

      /**
       * 播放详情页-是否允许通过歌词调整播放进度
       */
      // 'playDetail.isShowLyricProgressSetting': boolean

      /**
       * 播放详情页-歌词对齐方式
       */
      'playDetail.style.align': 'center' | 'left' | 'right'

      /**
       * 竖屏歌词字体大小
       */
      'playDetail.vertical.style.lrcFontSize': number

      /**
       * 横屏歌词字体大小
       */
      'playDetail.horizontal.style.lrcFontSize': number

      /**
       * 播放详情页-是否允许通过歌词调整播放进度
       */
      'playDetail.isShowLyricProgressSetting': boolean

      /**
       * 是否启用桌面歌词
       */
      'desktopLyric.enable': boolean

      /**
       * 是否锁定桌面歌词
       */
      'desktopLyric.isLock': boolean

      /**
       * 桌面歌词窗口宽度
       */
      'desktopLyric.width': number

      /**
       * 桌面歌词最大行数
       */
      'desktopLyric.maxLineNum': number

      /**
       * 桌面歌词是否使用单行显示
       */
      'desktopLyric.isSingleLine': boolean

      /**
       * 桌面歌词是否启用歌词切换动画
       */
      'desktopLyric.showToggleAnima': boolean

      /**
       * 桌面歌词窗口x坐标
       */
      'desktopLyric.position.x': number

      /**
       * 桌面歌词窗口y坐标
       */
      'desktopLyric.position.y': number

      /**
       * 歌词水平对齐方式
       */
      'desktopLyric.textPosition.x': 'left' | 'center' | 'right'

      /**
       * 歌词垂直对齐方式
       */
      'desktopLyric.textPosition.y': 'top' | 'center' | 'bottom'

      /**
       * 桌面歌词字体大小
       */
      'desktopLyric.style.fontSize': number

      /**
       * 桌面歌词字体透明度
       */
      'desktopLyric.style.opacity': number

      /**
       * 桌面歌词未播放字体颜色
       */
      'desktopLyric.style.lyricUnplayColor': string

      /**
        * 桌面歌词已播放字体颜色
        */
      'desktopLyric.style.lyricPlayedColor': string

      /**
        * 桌面歌词字体阴影颜色
        */
      'desktopLyric.style.lyricShadowColor': string

      /**
       * 是否显示热门搜索
       */
      'search.isShowHotSearch': boolean

      /**
       * 是否显示搜索历史
       */
      'search.isShowHistorySearch': boolean

      /**
       * 是否启用双击列表里的歌曲时自动切换到当前列表播放（仅对歌单、排行榜有效）
       */
      'list.isClickPlayList': boolean

      /**
       * 是否显示歌曲来源（仅对我的列表有效）
       */
      'list.isShowSource': boolean

      /**
       * 是否显示歌曲专辑名
       */
      'list.isShowAlbumName': boolean

      /**
       * 是否显示歌曲时长
       */
      'list.isShowInterval': boolean

      /**
       * 是否自动恢复列表滚动位置（仅对我的列表有效）
       */
      'list.isSaveScrollLocation': boolean

      /**
       * 添加歌曲到我的列表时的方式
       */
      'list.addMusicLocationType': AddMusicLocationType

      /**
       * 文件命名方式
       */
      'download.fileName': '歌名 - 歌手' | '歌手 - 歌名' | '歌名'

      /**
       * 下载音质
       */
      'download.quality': LX.QualitySetting

      /**
       * 是否启用同步
       */
      'sync.enable': boolean
    }
  }
}

