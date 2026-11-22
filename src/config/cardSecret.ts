// 短卡密（16 位）校验密钥：客户端与管理端共用，仅用于离线校验码
// 注意：短卡密是对称校验方案（长度限制导致无法塞进非对称签名），
// 安全性来自「密钥只存在于 APK 内」；如需最强防伪请使用旧版长卡密（RSA-2048）。
export const CARD_SECRET_HEX = '0b9615f52b3ea04c521698dd800d1e924baf4ab2ba8c698b870777b3f86ba28f'

/** 卡密版本：2 = 短格式 YIEYU-XXXX-XXXXX */
export const CARD_VERSION = 2
