// Yieyu 授权核（纯 C++，不依赖 JNI / Android）
//
// 这里只放「不想让 Java/JS 直接读到的东西」：
//   · AUTHZ_SECRET（对称密钥，构建期由 CI Secret 注入 authz_secret.h）
//   · 设备码派生、白名单条目键、迁移码编解码
//
// 约定（与 docs/AUTHZ.md 一致，改动必须两边同步）：
//   设备码 = format(sha256("yieyu-devcode|v3|" + seed)[0..16])     形如 ED1D-7DC1-F252-5FBA
//   条目键 = hex(hmac(secret, "yieyu-authz|v1|dev=" + normalize(设备码)))   64 位十六进制
//   迁移码 = "YMG1-" + base32(23 字节负载)，见 authz_core.cpp
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace yieyu {
namespace authz {

constexpr size_t kHashLen = 32;

/** SHA-256（整块内存） */
void sha256(const uint8_t* data, size_t len, uint8_t out[kHashLen]);
/** HMAC-SHA256 */
void hmacSha256(const uint8_t* key, size_t key_len, const uint8_t* data, size_t len, uint8_t out[kHashLen]);

void sha256String(const std::string& text, uint8_t out[kHashLen]);
void hmacSha256String(const uint8_t* key, size_t key_len, const std::string& text, uint8_t out[kHashLen]);

std::string toHex(const uint8_t* data, size_t len);
bool fromHex(const std::string& hex, uint8_t* out, size_t out_len);

/** 只保留 0-9A-Z（去掉分隔符与空白），统一大写 */
std::string normalizeCode(const std::string& raw);

/** 16 位十六进制 → XXXX-XXXX-XXXX-XXXX */
std::string formatDeviceCode(const std::string& hex16);

/** 设备码：seed 由 Java 层用硬件信息拼好，这里只负责派生与格式化 */
std::string deviceCode(const std::string& seed);

/** 白名单 / 黑名单条目键（64 位十六进制） */
std::string entryKey(const std::string& device_code);

/** 到期日编码：0 = 永久；单位为「2020-01-01 起的天数 + 1」，范围 1..32767 */
uint16_t expDayFromMs(int64_t exp_ms);
/** 0 表示永久或非法输入 */
int64_t expMsFromDay(uint16_t day);

struct Migration {
  bool ok = false;
  std::string reason;
  uint16_t exp_day = 0;
  int64_t issued_sec = 0;
  std::string src_tag;  // 8 位十六进制：老设备标签，只用于展示与排查
  uint32_t nonce = 0;
  std::string code;
};

/** 老设备导出迁移码；nonce 传 0 则内部随机 */
Migration migrateExport(const std::string& device_code, int64_t exp_ms, int64_t now_sec, uint32_t nonce);
/** 新设备导入；24 小时有效（含 5 分钟时钟容差） */
Migration migrateImport(const std::string& code, int64_t now_sec);

constexpr int64_t kMigrationTtlSec = 24 * 60 * 60;
constexpr int64_t kMigrationSkewSec = 5 * 60;

/** 自检：空串 = 通过，否则是失败原因 */
std::string selfTest();

}  // namespace authz
}  // namespace yieyu
