/**
 * 生产包里的 console 裁剪（Babel 插件）
 *
 * 为什么需要：仓库里 console.* 有 500+ 处，release 包也会全部执行 —— 既是启动/滚动时的无谓开销，
 * 也会把用户数据写进 logcat（安全问题）。
 *
 * 只删 console.log / info / debug / trace，**保留 warn / error**：
 * 真出问题时还得靠它们定位，不能一刀切。
 *
 * 安全约束：只处理「独立的 ExpressionStatement」（如 `console.log(x)` 这一整行）。
 * 像 `const a = console.log(1)` 这种把它当值用的写法一律不动，避免改变语义。
 */
const STRIP_METHODS = new Set(['log', 'info', 'debug', 'trace'])

module.exports = function stripConsole() {
  return {
    name: 'yieyu-strip-console',
    visitor: {
      ExpressionStatement(path) {
        const expression = path.node && path.node.expression
        if (!expression || expression.type !== 'CallExpression') return
        const callee = expression.callee
        if (!callee || callee.type !== 'MemberExpression') return
        const object = callee.object
        const property = callee.property
        if (!object || object.type !== 'Identifier' || object.name !== 'console') return
        if (!property || property.type !== 'Identifier') return
        if (!STRIP_METHODS.has(property.name)) return
        path.remove()
      },
    },
  }
}
