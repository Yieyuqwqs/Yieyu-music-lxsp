// 管理端私钥占位文件。
// 仓库里永远只有这个空实现；CI 构建管理端时会用 Secret 覆盖成真实私钥。
// 这样客户端包里绝不会带上私钥，也不会因为模块缺失导致构建失败。
export const LICENSE_PRIVATE_KEY: { e: string, n: string, d: string } | null = null
