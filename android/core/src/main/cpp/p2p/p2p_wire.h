/**
 * 一起听 · 直连通道线格式（纯 C++，零依赖）
 *
 * 只传控制消息（几十字节），不传音频。所以：
 *  - 不需要 TCP 的重传/拥塞控制（延迟优先）
 *  - 不依赖 WebRTC 那一坨（libwebrtc 几百 MB，编不动也没必要）
 *  - 自己做：STUN 打洞 + UDP 直连 + 序号去重 + 冗余发送
 */
#pragma once

#include <cstdint>
#include <cstddef>

namespace lxp2p {

// 魔数 "LXP1"
constexpr uint8_t kMagic0 = 'L';
constexpr uint8_t kMagic1 = 'X';
constexpr uint8_t kMagic2 = 'P';
constexpr uint8_t kMagic3 = '1';

constexpr size_t kHeaderSize = 12;   // magic(4) + seq(4) + flags(2) + len(2)
constexpr size_t kMaxPayload = 1200; // 控制消息远小于 MTU

enum Flags : uint16_t {
  kFlagKeepalive = 1 << 0,
  kFlagControl = 1 << 1,
};

struct Packet {
  uint32_t seq = 0;
  uint16_t flags = 0;
  const uint8_t* payload = nullptr;
  uint16_t length = 0;
};

/** 把 payload 编码进 out（返回总长度，0 表示失败） */
size_t encode_packet(uint8_t* out, size_t cap, uint32_t seq, uint16_t flags, const uint8_t* payload, size_t length);

/** 解析；返回 true 表示是合法包 */
bool decode_packet(const uint8_t* data, size_t size, Packet& out);

/** 去重窗口：乱序/重复都吞掉（UDP 直连会有重复包） */
class DedupWindow {
 public:
  /** 返回 true = 首次见到，应该往上送 */
  bool accept(uint32_t seq);
 private:
  uint32_t highest_ = 0;
  uint64_t seen_bitmap_ = 0;  // 最近 64 个序号
  bool inited_ = false;
};

}  // namespace lxp2p
