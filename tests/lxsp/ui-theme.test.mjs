/**
 * 壁纸皮肤 & 全局字体：数据与接线契约
 *
 * 这组测试守两件事：
 *   1. 「雪见」主题必须是**半透明**的，且只有它声明了面板透明度（其余主题行为不许被改变）；
 *   2. 字体设置必须真的接到三个文本渲染器上（否则设置项就是个摆设）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import themes from '../../src/theme/themes/themes.ts'
import { FONT_FAMILY_OPTIONS, isFontFamilyValue } from '../../src/theme/fontOptions.ts'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const exists = (rel) => existsSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)))

export default (t) => {
  t.suite('壁纸皮肤：雪见主题必须是半透明的，且不影响其它主题', () => {
    const list = themes
    const snow = list.find(theme => theme.id === 'snow')
    t.ok(!!snow, '必须有 id=snow 的内置主题')
    t.eq(snow.name, '雪见', '主题名固定为「雪见」')
    t.eq(snow.isDark, false, '雪见是浅色主题')

    const contentBg = snow.config.extInfo['c-content-background']
    t.ok(typeof contentBg === 'string' && contentBg.startsWith('rgba('), `面板底色必须是半透明 rgba，实际 ${contentBg}`)
    const alpha = Number(contentBg.slice(contentBg.lastIndexOf(',') + 1).replace(')', ''))
    t.ok(alpha > 0.2 && alpha < 0.8, `透明度要落在 0.2~0.8 之间（太实壁纸透不出来、太透字看不清），实际 ${alpha}`)

    // 只有雪见声明了 c-content-background：其它主题还是走「主色推导」，外观零变化
    const overrideThemes = list.filter(theme => typeof theme.config.extInfo['c-content-background'] === 'string')
    t.eq(overrideThemes.map(theme => theme.id), ['snow'], '只允许雪见覆盖面板透明度')

    t.ok(list.length >= 17, `主题数量不能变少（>=17），实际 ${list.length}`)
    const ids = list.map(theme => theme.id)
    t.eq(new Set(ids).size, ids.length, '主题 id 不能重复')
  })

  t.suite('全局字体：选项必须是系统保证存在的字体族', () => {
    const ids = FONT_FAMILY_OPTIONS.map(item => item.id)
    t.eq(ids, ['', 'serif', 'sans-serif-light'], '三个选项固定：系统 / 衬线 / 细体')
    t.ok(FONT_FAMILY_OPTIONS.every(item => item.labelKey.startsWith('setting_theme_font_family_')), '每个选项都要有 i18n key')
    t.ok(isFontFamilyValue('serif') && isFontFamilyValue('') && !isFontFamilyValue('comic'), '取值校验必须拦住非法字体族')
  })

  t.suite('全局字体：设置项与文本渲染器的接线都在', () => {
    const types = read('src/types/app_setting.d.ts')
    t.ok(/'theme\.fontFamily': string/.test(types), '设置类型必须声明 theme.fontFamily')
    t.ok(/'theme\.fontFamily': ''/.test(read('src/config/defaultSetting.ts')), '默认值必须是空串（默认外观零变化）')

    const text = read('src/components/common/Text.tsx')
    const injected = (text.match(/\.\.\.fontFamily,/g) || []).length
    t.eq(injected, 6, `三个渲染器 × 两种分支都要注入 fontFamily，实际 ${injected} 处`)
    t.ok(text.includes("from '@/theme/font'"), 'Text 必须从主题模块取字体')
    t.ok(text.includes('useFontFamilyStyle()'), '必须用 hook 读取设置（切换后立即生效）')

    t.ok(exists('src/screens/Home/Views/Setting/settings/Theme/FontFamily.tsx'), '设置页必须有字体选择组件')
    t.ok(read('src/screens/Home/Views/Setting/settings/Theme/index.tsx').includes('<FontFamily />'), '字体组件必须挂进主题设置页')

    for (const lang of ['zh-cn', 'zh-tw', 'en-us']) {
      const dict = JSON.parse(read(`src/lang/${lang}.json`))
      for (const key of ['setting_theme_font_family', ...FONT_FAMILY_OPTIONS.map(item => item.labelKey)]) {
        t.ok(!!dict[key], `${lang} 缺少 ${key}`)
      }
    }
  })
}
