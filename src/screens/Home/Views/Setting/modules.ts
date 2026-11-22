import { type SettingScreenIds } from './Main'

export interface SettingEntry {
  id: SettingScreenIds
  icon: string
  descKey: string
}

export interface SettingModule {
  id: string
  icon: string
  titleKey: string
  descKey: string
  /** 模块主色，用于图标底座与行内强调色 */
  accent: string
  entries: SettingEntry[]
}

/**
 * 设置页五大模块（极客风分组）
 * 顺序即展示顺序：核心声学引擎 → Hi-Fi 解析中枢 → 极光视界 → 极速闪传 → 安全与更新
 */
export const SETTING_MODULES: SettingModule[] = [
  {
    id: 'acoustic',
    icon: 'volume-higt',
    titleKey: 'setting_module_acoustic',
    descKey: 'setting_module_acoustic_desc',
    accent: '#5ad1a5',
    entries: [
      { id: 'player', icon: 'playback-rate', descKey: 'setting_entry_player_desc' },
      { id: 'history', icon: 'music_time', descKey: 'setting_entry_history_desc' },
    ],
  },
  {
    id: 'hifi',
    icon: 'volume-higt',
    titleKey: 'setting_module_hifi',
    descKey: 'setting_module_hifi_desc',
    accent: '#6ee7b7',
    entries: [
      { id: 'hifi', icon: 'share', descKey: 'setting_entry_hifi_desc' },
    ],
  },
  {
    id: 'visual',
    icon: 'album',
    titleKey: 'setting_module_visual',
    descKey: 'setting_module_visual_desc',
    accent: '#8ab4ff',
    entries: [
      { id: 'basic', icon: 'setting', descKey: 'setting_entry_basic_desc' },
      { id: 'lyric_desktop', icon: 'lyric-on', descKey: 'setting_entry_lyric_desktop_desc' },
      { id: 'list', icon: 'list-order', descKey: 'setting_entry_list_desc' },
      { id: 'search', icon: 'search-2', descKey: 'setting_entry_search_desc' },
    ],
  },
  {
    id: 'transfer',
    icon: 'share',
    titleKey: 'setting_module_transfer',
    descKey: 'setting_module_transfer_desc',
    accent: '#ffc46b',
    entries: [
      { id: 'sync', icon: 'list-loop', descKey: 'setting_entry_sync_desc' },
      { id: 'backup', icon: 'sd-card', descKey: 'setting_entry_backup_desc' },
    ],
  },
  {
    id: 'security',
    icon: 'available_updates',
    titleKey: 'setting_module_security',
    descKey: 'setting_module_security_desc',
    accent: '#ff8f8f',
    entries: [
      { id: 'version', icon: 'available_updates', descKey: 'setting_entry_version_desc' },
      { id: 'about', icon: 'help', descKey: 'setting_entry_about_desc' },
      { id: 'other', icon: 'dots-vertical', descKey: 'setting_entry_other_desc' },
    ],
  },
]

/** 模块 id → 隶属的设置面板，横向模式左侧导航按模块折叠 */
export const getModuleOfScreen = (id: SettingScreenIds) => {
  return SETTING_MODULES.find(module => module.entries.some(entry => entry.id === id))
}
