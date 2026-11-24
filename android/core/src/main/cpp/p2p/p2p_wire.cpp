#include "p2p_wire.h"

#include <cstring>

namespace lxp2p {

size_t encode_packet(uint8_t* out, size_t cap, uint32_t seq, uint16_t flags,
                     const uint8_t* payload, size_t length) {
  if (out == nullptr) return 0;
  if (length > kMaxPayload || cap < kHeaderSize + length) return 0;
  out[0] = kMagic0;
  out[1] = kMagic1;
  out[2] = kMagic2;
  out[3] = kMagic3;
  out[4] = static_cast<uint8_t>((seq >> 24) & 0xff);
  out[5] = static_cast<uint8_t>((seq >> 16) & 0xff);
  out[6] = static_cast<uint8_t>((seq >> 8) & 0xff);
  out[7] = static_cast<uint8_t>(seq & 0xff);
  out[8] = static_cast<uint8_t>((flags >> 8) & 0xff);
  out[9] = static_cast<uint8_t>(flags & 0xff);
  out[10] = static_cast<uint8_t>((length >> 8) & 0xff);
  out[11] = static_cast<uint8_t>(length & 0xff);
  if (length > 0 && payload != nullptr) std::memcpy(out + kHeaderSize, payload, length);
  return kHeaderSize + length;
}

bool decode_packet(const uint8_t* data, size_t size, Packet& out) {
  if (data == nullptr || size < kHeaderSize) return false;
  if (data[0] != kMagic0 || data[1] != kMagic1 || data[2] != kMagic2 || data[3] != kMagic3) return false;
  const uint32_t seq = (static_cast<uint32_t>(data[4]) << 24) | (static_cast<uint32_t>(data[5]) << 16) |
                       (static_cast<uint32_t>(data[6]) << 8) | static_cast<uint32_t>(data[7]);
  const uint16_t flags = static_cast<uint16_t>((data[8] << 8) | data[9]);
  const uint16_t length = static_cast<uint16_t>((data[10] << 8) | data[11]);
  if (length > kMaxPayload || size < kHeaderSize + length) return false;
  out.seq = seq;
  out.flags = flags;
  out.length = length;
  out.payload = data + kHeaderSize;
  return true;
}

bool DedupWindow::accept(uint32_t seq) {
  if (!inited_) {
    inited_ = true;
    highest_ = seq;
    seen_bitmap_ = 1;
    return true;
  }
  if (seq > highest_) {
    const uint32_t shift = seq - highest_;
    seen_bitmap_ = shift >= 64 ? 1 : ((seen_bitmap_ << shift) | 1);
    highest_ = seq;
    return true;
  }
  const uint32_t back = highest_ - seq;
  if (back >= 64) return false;
  const uint64_t bit = uint64_t{1} << back;
  if (seen_bitmap_ & bit) return false;
  seen_bitmap_ |= bit;
  return true;
}

}  // namespace lxp2p
