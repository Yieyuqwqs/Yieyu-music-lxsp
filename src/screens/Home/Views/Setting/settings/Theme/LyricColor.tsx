import { memo, useMemo } from 'react'
import { TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'
import { useLyricPalette } from '@/utils/colorContrast'

/**
 * 歌词颜色（星光跳动的当前行主色）。
 * 选「自动」时回到自动对比度：亮底黑字 / 暗底白字，永远不会瞎眼。
 */
const COLORS = [
  '#FF6B9D', // 星光粉
  '#FFD166', // 星光金
  '#6EE7B7', // 极光绿
  '#7DD3FC', // 冰蓝
  '#C4B5FD', // 星云紫
  '#FF9F7A', // 落日橙
]

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const current = useSettingValue('playDetail.lyricColor') ?? ''
  const palette = useLyricPalette(current)

  const previewShadow = useMemo(() => ({
    textShadowColor: palette.glow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  }), [palette.glow])

  return (
    <SubTitle title={t('setting_lyric_color')}>
      <View style={styles.list}>
        <TouchableOpacity
          style={[styles.chip, current === '' ? { borderColor: theme['c-primary'], borderWidth: 1.5 } : null]}
          onPress={() => { updateSetting({ 'playDetail.lyricColor': '' }) }}
          activeOpacity={0.7}
        >
          <Text size={12} color={current === '' ? theme['c-primary-font'] : theme['c-font-label']}>
            {t('setting_lyric_color_auto')}
          </Text>
        </TouchableOpacity>
        {COLORS.map(color => (
          <TouchableOpacity
            key={color}
            style={[
              styles.item,
              { backgroundColor: color },
              current === color ? { borderWidth: 2, borderColor: theme['c-font'] } : null,
            ]}
            onPress={() => { updateSetting({ 'playDetail.lyricColor': color }) }}
            activeOpacity={0.8}
          />
        ))}
      </View>
      <View style={[styles.preview, { backgroundColor: theme['c-main-background'] }]}>
        <Text size={16} style={[styles.previewText, { color: palette.active }, previewShadow]}>
          星光跳动 · 歌词预览
        </Text>
        <Text size={11} style={[styles.previewSub, { color: palette.inactive }]}>
          上一行与下一行保持半透明；当前行加粗并带描边兜底
        </Text>
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  chip: {
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 10,
    marginRight: 10,
    marginBottom: 10,
    backgroundColor: 'rgba(127,127,127,0.16)',
  },
  item: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: 10,
    marginBottom: 10,
  },
  preview: {
    marginTop: 2,
    marginBottom: 2,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  previewText: {
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  previewSub: {
    paddingTop: 5,
  },
})
