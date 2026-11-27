// Yieyu 授权核实现：SHA-256 / HMAC-SHA256 / Crockford Base32 / 设备码 / 白名单键 / 迁移码
// 没有第三方依赖，C++17，只吃标准库（不许用 <android/log.h>，保持可单测）。
#include "authz_core.h"

#include <cstring>
#include <ctime>
#include <random>
#include <vector>

#include "authz_secret.h"

namespace yieyu {
namespace authz {
namespace {

const uint32_t kSha256K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

const char kHexLower[] = "0123456789abcdef";
// Crockford Base32：去掉容易看错的 I L O U
const char kCrockford[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const char kDevSalt[] = "yieyu-devcode|v3|";
const char kKeySalt[] = "yieyu-authz|v1|dev=";
const char kQqSalt[] = "yieyu-qq|v1|qq=";
const char kSignSalt[] = "yieyu-sign|v1|";
const char kMigrateSalt[] = "yieyu-migrate|v1|";
const char kMigrateSrcSalt[] = "yieyu-migrate|src|";
const char kMigratePrefix[] = "YMG1";

constexpr int64_t kDayMs = 86400000LL;
// 2020-01-01 距 1970-01-01 的天数
constexpr int64_t kEpochDay = 18262LL;
constexpr size_t kPayloadLen = 23;
constexpr size_t kBodyLen = 15;

inline uint32_t rotr(uint32_t value, int bits) {
  return (value >> bits) | (value << (32 - bits));
}

inline uint32_t loadBE32(const uint8_t* data) {
  return (static_cast<uint32_t>(data[0]) << 24) | (static_cast<uint32_t>(data[1]) << 16) |
         (static_cast<uint32_t>(data[2]) << 8) | static_cast<uint32_t>(data[3]);
}

inline void storeBE32(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>((value >> 24) & 0xFF);
  out[1] = static_cast<uint8_t>((value >> 16) & 0xFF);
  out[2] = static_cast<uint8_t>((value >> 8) & 0xFF);
  out[3] = static_cast<uint8_t>(value & 0xFF);
}

void sha256Block(const uint8_t* block, uint32_t state[8]) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) w[i] = loadBE32(block + i * 4);
  for (int i = 16; i < 64; i++) {
    const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 64; i++) {
    const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const uint32_t ch = (e & f) ^ ((~e) & g);
    const uint32_t t1 = h + s1 + ch + kSha256K[i] + w[i];
    const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

void secretKey(uint8_t out[kHashLen]) {
  for (size_t i = 0; i < kHashLen; i++) out[i] = static_cast<uint8_t>(kAuthzKeyMasked[i] ^ kAuthzKeyMask);
}

int crockfordIndex(char raw) {
  char ch = raw;
  if (ch >= 'a' && ch <= 'z') ch = static_cast<char>(ch - 'a' + 'A');
  if (ch == 'I' || ch == 'L') ch = '1';
  if (ch == 'O') ch = '0';
  if (ch == 'U') ch = 'V';
  for (int i = 0; i < 32; i++) {
    if (kCrockford[i] == ch) return i;
  }
  return -1;
}

std::string base32Encode(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve((len * 8 + 4) / 5);
  uint32_t buffer = 0;
  int bits = 0;
  for (size_t i = 0; i < len; i++) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      out.push_back(kCrockford[(buffer >> (bits - 5)) & 0x1F]);
      bits -= 5;
    }
  }
  if (bits > 0) out.push_back(kCrockford[(buffer << (5 - bits)) & 0x1F]);
  return out;
}

bool base32Decode(const std::string& text, std::vector<uint8_t>* out) {
  out->clear();
  out->reserve(text.size() * 5 / 8);
  uint32_t buffer = 0;
  int bits = 0;
  for (char ch : text) {
    const int index = crockfordIndex(ch);
    if (index < 0) return false;
    buffer = (buffer << 5) | static_cast<uint32_t>(index);
    bits += 5;
    if (bits >= 8) {
      out->push_back(static_cast<uint8_t>((buffer >> (bits - 8)) & 0xFF));
      bits -= 8;
    }
  }
  return true;
}

uint32_t randomU32() {
  std::random_device device;
  uint32_t value = static_cast<uint32_t>(device()) ^ static_cast<uint32_t>(std::time(nullptr));
  value ^= static_cast<uint32_t>(device()) << 16;
  return value == 0 ? 0x9E3779B9u : value;
}

bool containsOnlySpaceOrDash(char ch) {
  return ch == ' ' || ch == '-' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '|' || ch == '_' || ch == '.';
}

}  // namespace

void sha256(const uint8_t* data, size_t len, uint8_t out[kHashLen]) {
  uint32_t state[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                       0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};

  size_t offset = 0;
  while (len - offset >= 64) {
    sha256Block(data + offset, state);
    offset += 64;
  }

  uint8_t tail[128];
  std::memset(tail, 0, sizeof(tail));
  const size_t rest = len - offset;
  if (rest > 0) std::memcpy(tail, data + offset, rest);
  tail[rest] = 0x80;
  const size_t tailLen = (rest + 9 <= 64) ? 64 : 128;
  const uint64_t bitLen = static_cast<uint64_t>(len) * 8u;
  for (int i = 0; i < 8; i++) {
    tail[tailLen - 1 - i] = static_cast<uint8_t>((bitLen >> (8 * i)) & 0xFF);
  }

  sha256Block(tail, state);
  if (tailLen == 128) sha256Block(tail + 64, state);

  for (int i = 0; i < 8; i++) storeBE32(out + i * 4, state[i]);
}

void hmacSha256(const uint8_t* key, size_t key_len, const uint8_t* data, size_t len, uint8_t out[kHashLen]) {
  uint8_t block[64];
  std::memset(block, 0, sizeof(block));
  if (key_len > 64) {
    uint8_t digest[kHashLen];
    sha256(key, key_len, digest);
    std::memcpy(block, digest, kHashLen);
  } else if (key_len > 0) {
    std::memcpy(block, key, key_len);
  }

  uint8_t inner[64];
  uint8_t outer[64];
  for (int i = 0; i < 64; i++) {
    inner[i] = static_cast<uint8_t>(block[i] ^ 0x36);
    outer[i] = static_cast<uint8_t>(block[i] ^ 0x5c);
  }

  uint8_t innerDigest[kHashLen];
  {
    // sha256(inner || data)
    uint32_t state[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
    sha256Block(inner, state);
    size_t offset = 0;
    while (len - offset >= 64) {
      sha256Block(data + offset, state);
      offset += 64;
    }
    uint8_t tail[128];
    std::memset(tail, 0, sizeof(tail));
    const size_t rest = len - offset;
    if (rest > 0) std::memcpy(tail, data + offset, rest);
    tail[rest] = 0x80;
    const size_t tailLen = (rest + 9 <= 64) ? 64 : 128;
    const uint64_t bitLen = static_cast<uint64_t>(len + 64) * 8u;
    for (int i = 0; i < 8; i++) {
      tail[tailLen - 1 - i] = static_cast<uint8_t>((bitLen >> (8 * i)) & 0xFF);
    }
    sha256Block(tail, state);
    if (tailLen == 128) sha256Block(tail + 64, state);
    for (int i = 0; i < 8; i++) storeBE32(innerDigest + i * 4, state[i]);
  }

  uint8_t outerInput[96];
  std::memcpy(outerInput, outer, 64);
  std::memcpy(outerInput + 64, innerDigest, kHashLen);
  sha256(outerInput, 96, out);
}

void sha256String(const std::string& text, uint8_t out[kHashLen]) {
  sha256(reinterpret_cast<const uint8_t*>(text.data()), text.size(), out);
}

void hmacSha256String(const uint8_t* key, size_t key_len, const std::string& text, uint8_t out[kHashLen]) {
  hmacSha256(key, key_len, reinterpret_cast<const uint8_t*>(text.data()), text.size(), out);
}

std::string toHex(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out.push_back(kHexLower[(data[i] >> 4) & 0x0F]);
    out.push_back(kHexLower[data[i] & 0x0F]);
  }
  return out;
}

bool fromHex(const std::string& hex, uint8_t* out, size_t out_len) {
  if (hex.size() != out_len * 2) return false;
  for (size_t i = 0; i < out_len; i++) {
    int hi = -1;
    int lo = -1;
    for (int pass = 0; pass < 2; pass++) {
      const char ch = hex[i * 2 + static_cast<size_t>(pass)];
      int value = -1;
      if (ch >= '0' && ch <= '9') value = ch - '0';
      else if (ch >= 'a' && ch <= 'f') value = ch - 'a' + 10;
      else if (ch >= 'A' && ch <= 'F') value = ch - 'A' + 10;
      if (pass == 0) hi = value; else lo = value;
    }
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return true;
}

std::string normalizeCode(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  for (char ch : raw) {
    if (ch >= '0' && ch <= '9') {
      out.push_back(ch);
    } else if (ch >= 'a' && ch <= 'z') {
      out.push_back(static_cast<char>(ch - 'a' + 'A'));
    } else if (ch >= 'A' && ch <= 'Z') {
      out.push_back(ch);
    }
  }
  return out;
}

std::string formatDeviceCode(const std::string& hex16) {
  std::string clean;
  clean.reserve(hex16.size());
  for (char ch : hex16) {
    if (ch >= 'a' && ch <= 'z') clean.push_back(static_cast<char>(ch - 'a' + 'A'));
    else clean.push_back(ch);
  }
  if (clean.size() != 16) return clean;
  std::string out;
  out.reserve(19);
  for (size_t i = 0; i < clean.size(); i += 4) {
    if (i > 0) out.push_back('-');
    out.append(clean, i, 4);
  }
  return out;
}

std::string deviceCode(const std::string& seed) {
  uint8_t digest[kHashLen];
  sha256String(std::string(kDevSalt) + seed, digest);
  return formatDeviceCode(toHex(digest, kHashLen).substr(0, 16));
}

std::string entryKey(const std::string& device_code) {
  uint8_t key[kHashLen];
  secretKey(key);
  uint8_t mac[kHashLen];
  hmacSha256String(key, kHashLen, std::string(kKeySalt) + normalizeCode(device_code), mac);
  return toHex(mac, kHashLen);
}

std::string qqKey(const std::string& qq) {
  const std::string normalized = normalizeCode(qq);
  uint8_t key[kHashLen];
  secretKey(key);
  uint8_t mac[kHashLen];
  hmacSha256String(key, kHashLen, std::string(kQqSalt) + normalized, mac);
  return toHex(mac, kHashLen);
}

std::string signText(const std::string& text) {
  uint8_t key[kHashLen];
  secretKey(key);
  uint8_t mac[kHashLen];
  hmacSha256String(key, kHashLen, std::string(kSignSalt) + text, mac);
  return toHex(mac, kHashLen);
}

uint16_t expDayFromMs(int64_t exp_ms) {
  if (exp_ms <= 0) return 0;
  const int64_t day = exp_ms / kDayMs - (kEpochDay - 1);
  if (day <= 0) return 1;
  if (day > 32767) return 32767;
  return static_cast<uint16_t>(day);
}

int64_t expMsFromDay(uint16_t day) {
  if (day == 0) return 0;
  return (kEpochDay + static_cast<int64_t>(day)) * kDayMs - 1;
}

Migration migrateExport(const std::string& device_code, int64_t exp_ms, int64_t now_sec, uint32_t nonce) {
  Migration result;
  const std::string normalized = normalizeCode(device_code);
  if (normalized.size() < 8) {
    result.reason = "设备码无效";
    return result;
  }
  if (now_sec <= 0) now_sec = static_cast<int64_t>(std::time(nullptr));
  if (nonce == 0) nonce = randomU32();

  uint8_t body[kBodyLen];
  std::memset(body, 0, sizeof(body));
  const uint16_t day = expDayFromMs(exp_ms);
  body[0] = 1;
  body[1] = static_cast<uint8_t>((day >> 8) & 0xFF);
  body[2] = static_cast<uint8_t>(day & 0xFF);
  storeBE32(body + 3, static_cast<uint32_t>(now_sec & 0xFFFFFFFFLL));
  storeBE32(body + 7, nonce);

  uint8_t tag[kHashLen];
  sha256String(std::string(kMigrateSrcSalt) + normalized, tag);
  std::memcpy(body + 11, tag, 4);

  uint8_t key[kHashLen];
  secretKey(key);
  uint8_t mac[kHashLen];
  hmacSha256String(key, kHashLen, std::string(kMigrateSalt) + toHex(body, kBodyLen), mac);

  uint8_t payload[kPayloadLen];
  std::memcpy(payload, body, kBodyLen);
  std::memcpy(payload + kBodyLen, mac, kPayloadLen - kBodyLen);

  result.ok = true;
  result.exp_day = day;
  result.issued_sec = now_sec;
  result.src_tag = toHex(tag, 4);
  result.nonce = nonce;
  result.code = std::string(kMigratePrefix) + "-" + base32Encode(payload, kPayloadLen);
  return result;
}

Migration migrateImport(const std::string& code, int64_t now_sec) {
  Migration result;
  std::string cleaned;
  for (char ch : code) {
    if (containsOnlySpaceOrDash(ch)) continue;
    if (ch >= 'a' && ch <= 'z') cleaned.push_back(static_cast<char>(ch - 'a' + 'A'));
    else cleaned.push_back(ch);
  }
  if (cleaned.rfind(kMigratePrefix, 0) == 0) cleaned = cleaned.substr(std::strlen(kMigratePrefix));

  std::vector<uint8_t> payload;
  if (!base32Decode(cleaned, &payload)) {
    result.reason = "迁移码格式不正确";
    return result;
  }
  if (payload.size() != kPayloadLen) {
    result.reason = "迁移码不完整";
    return result;
  }
  if (payload[0] != 1) {
    result.reason = "迁移码版本不支持";
    return result;
  }

  uint8_t key[kHashLen];
  secretKey(key);
  uint8_t mac[kHashLen];
  hmacSha256String(key, kHashLen, std::string(kMigrateSalt) + toHex(payload.data(), kBodyLen), mac);
  if (std::memcmp(mac, payload.data() + kBodyLen, kPayloadLen - kBodyLen) != 0) {
    result.reason = "迁移码无效";
    return result;
  }

  const uint16_t day = static_cast<uint16_t>((static_cast<uint16_t>(payload[1]) << 8) | payload[2]);
  const int64_t issued = static_cast<int64_t>(loadBE32(payload.data() + 3));
  const uint32_t nonce = loadBE32(payload.data() + 7);

  if (now_sec <= 0) now_sec = static_cast<int64_t>(std::time(nullptr));
  if (issued > now_sec + kMigrationSkewSec) {
    result.reason = "迁移码时间异常，请校准系统时间";
    return result;
  }
  if (now_sec - issued > kMigrationTtlSec + kMigrationSkewSec) {
    result.reason = "迁移码已过期（24 小时内有效）";
    return result;
  }
  if (day != 0) {
    const int64_t exp_ms = expMsFromDay(day);
    if (exp_ms > 0 && now_sec * 1000 > exp_ms) {
      result.reason = "授权已到期，无法迁移";
      return result;
    }
  }

  result.ok = true;
  result.exp_day = day;
  result.issued_sec = issued;
  result.nonce = nonce;
  result.src_tag = toHex(payload.data() + 11, 4);
  result.code = base32Encode(payload.data(), kPayloadLen);
  return result;
}

std::string selfTest() {
  uint8_t digest[kHashLen];

  sha256String("abc", digest);
  if (toHex(digest, kHashLen) != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
    return "sha256(abc) 向量不匹配";
  }
  sha256String("", digest);
  if (toHex(digest, kHashLen) != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
    return "sha256(\"\") 向量不匹配";
  }

  hmacSha256String(reinterpret_cast<const uint8_t*>("key"), 3,
                   "The quick brown fox jumps over the lazy dog", digest);
  if (toHex(digest, kHashLen) != "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8") {
    return "hmac-sha256 向量不匹配";
  }

  // 与 tests/authz 的 JS 参考实现共用同一组向量
  if (deviceCode("test-seed") != "ED1D-7DC1-F252-5FBA") return "设备码派生不匹配";

  uint8_t sample[kPayloadLen];
  for (size_t i = 0; i < kPayloadLen; i++) sample[i] = static_cast<uint8_t>(i * 7 + 3);
  const std::string encoded = base32Encode(sample, kPayloadLen);
  std::vector<uint8_t> decoded;
  if (!base32Decode(encoded, &decoded) || decoded.size() != kPayloadLen ||
      std::memcmp(decoded.data(), sample, kPayloadLen) != 0) {
    return "base32 往返失败";
  }

  const int64_t now = 1735689600LL;  // 2025-01-01T00:00:00Z
  const Migration exported = migrateExport("ED1D-7DC1-F252-5FBA", 0, now, 0x1234ABCDu);
  if (!exported.ok) return "迁移码导出失败: " + exported.reason;
  const Migration imported = migrateImport(exported.code, now + 60);
  if (!imported.ok) return "迁移码导入失败: " + imported.reason;
  if (imported.exp_day != exported.exp_day || imported.nonce != exported.nonce ||
      imported.src_tag != exported.src_tag) {
    return "迁移码字段不一致";
  }

  std::string broken = exported.code;
  const char pivot = broken[8];
  broken[8] = pivot == 'A' ? 'B' : 'A';
  if (migrateImport(broken, now + 60).ok) return "迁移码篡改未被拦截";
  if (migrateImport(exported.code, now + kMigrationTtlSec + kMigrationSkewSec + 60).ok) {
    return "迁移码过期未被拦截";
  }

  const int64_t sample_ms = 1800000000000LL;
  const uint16_t day = expDayFromMs(sample_ms);
  if (day == 0 || expMsFromDay(day) < sample_ms) return "到期日编码不匹配";
  if (expDayFromMs(0) != 0 || expMsFromDay(0) != 0) return "永久授权编码不匹配";

  if (entryKey("ED1D-7DC1-F252-5FBA").size() != 64) return "条目键长度异常";
  if (qqKey("123456789").size() != 64) return "QQ 条目键长度异常";
  if (qqKey("123456789") != qqKey(" 123456789 ")) return "QQ 条目键未归一化";
  if (entryKey("ED1D-7DC1-F252-5FBA") != entryKey("ed1d-7dc1-f252-5fba")) return "条目键未归一化";

  return std::string();
}

}  // namespace authz
}  // namespace yieyu
