/**
 * @format
 */
import './shim'
import { APP_VARIANT } from '@/config/variant'

console.log('[Yieyu] variant =', APP_VARIANT)

// 同步加载：RNN 的 app launched 事件需要先完成组件注册
// 入口由 scripts/set-variant.js 按构建变体生成，另一个分支不会被 Metro 打进包里
require('@/app')
