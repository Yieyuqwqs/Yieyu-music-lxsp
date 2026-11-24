#include "p2p_peer.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <pthread.h>

#include "p2p_stun.h"
#include "p2p_wire.h"

namespace lxp2p {
namespace {
std::mutex g_send_mutex;
}

bool UdpPeer::start(const char* stun_host, uint16_t stun_port, int timeout_ms, std::string& out_error) {
  if (fd_ >= 0) return true;
  const StunResult stun = stun_discover(stun_host, stun_port, timeout_ms);
  private_ip_ = local_ipv4();
  if (!stun.ok) {
    out_error = "stun failed: " + stun.error;
    return false;
  }
  mapped_ = stun.ip + ":" + std::to_string(stun.port);

  // 用同一个 socket 打洞（与 STUN 的映射保持一对，否则 NAT 映射不同会失效）
  struct addrinfo hints {};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo* info = nullptr;
  if (::getaddrinfo(stun.ip.c_str(), nullptr, &hints, &info) != 0 || info == nullptr) {
    out_error = "resolve mapped failed";
    return false;
  }
  ::freeaddrinfo(info);

  fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (fd_ < 0) {
    out_error = "socket failed";
    return false;
  }
  struct timeval tv {};
  tv.tv_sec = 0;
  tv.tv_usec = 200 * 1000;
  ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  // 收发缓冲拉大：宁可多占 1MB，也不要因为缓冲区小丢包
  int buf = 1024 * 1024;
  ::setsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &buf, sizeof(buf));
  ::setsockopt(fd_, SOL_SOCKET, SO_SNDBUF, &buf, sizeof(buf));
  // TOS = 0xB8（DSCP EF 加速转发）：蜂窝网未必生效，但生效就是白赚
  int tos = 0xB8;
  ::setsockopt(fd_, IPPROTO_IP, IP_TOS, &tos, sizeof(tos));
  running_.store(true);
  thread_ = std::thread([this]() {
    // 接收线程优先：抖动越小，对齐越稳
    ::setpriority(PRIO_PROCESS, static_cast<id_t>(::gettid()), -10);
    this->recv_loop();
  });
  return true;
}

bool UdpPeer::connect_to(const char* ip, uint16_t port) {
  if (fd_ < 0) return false;
  struct sockaddr_in addr {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  if (::inet_pton(AF_INET, ip, &addr.sin_addr) != 1) return false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    std::memcpy(&remote_, &addr, sizeof(addr));
    has_remote_ = true;
    stats_.remote = std::string(ip) + ":" + std::to_string(port);
  }
  // 打洞：连发 8 个 keepalive，200ms 一个（对方也在发，总能撞上）
  for (int i = 0; i < 8; i++) {
    punch_once();
    ::usleep(200 * 1000);
  }
  return true;
}

void UdpPeer::punch_once() {
  uint8_t buffer[kHeaderSize];
  const size_t length = encode_packet(buffer, sizeof(buffer), seq_.fetch_add(1), kFlagKeepalive, nullptr, 0);
  std::lock_guard<std::mutex> lock(mutex_);
  if (!has_remote_ || fd_ < 0) return;
  ::sendto(fd_, buffer, length, 0, reinterpret_cast<struct sockaddr*>(&remote_), sizeof(struct sockaddr_in));
}

void UdpPeer::recv_loop() {
  uint8_t buffer[2048];
  while (running_.load()) {
    struct sockaddr_storage from {};
    socklen_t from_len = sizeof(from);
    const ssize_t got = ::recvfrom(fd_, buffer, sizeof(buffer), 0, reinterpret_cast<struct sockaddr*>(&from), &from_len);
    if (got <= 0) continue;
    Packet packet;
    if (!decode_packet(buffer, static_cast<size_t>(got), packet)) continue;
    if (packet.flags & kFlagKeepalive) {
      std::lock_guard<std::mutex> lock(mutex_);
      stats_.connected = true;
      continue;
    }
    std::vector<uint8_t> copy(packet.payload, packet.payload + packet.length);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stats_.received += 1;
      stats_.connected = true;
      if (inbox_.size() < 256) inbox_.push_back(std::move(copy));
      else stats_.dropped += 1;
    }
  }
}

bool UdpPeer::send_payload(const uint8_t* data, size_t size) {
  if (fd_ < 0) return false;
  std::lock_guard<std::mutex> guard(g_send_mutex);
  uint8_t buffer[kHeaderSize + kMaxPayload];
  const size_t length = encode_packet(buffer, sizeof(buffer), seq_.fetch_add(1), kFlagControl, data, size);
  if (length == 0) return false;
  std::lock_guard<std::mutex> lock(mutex_);
  if (!has_remote_) return false;
  const ssize_t wrote = ::sendto(fd_, buffer, length, 0,
                                 reinterpret_cast<struct sockaddr*>(&remote_), sizeof(struct sockaddr_in));
  // 立即再发一份：不占 CPU（一次 syscall），但把尾包丢失率直接砍半
  if (wrote > 0) ::sendto(fd_, buffer, length, 0,
                          reinterpret_cast<struct sockaddr*>(&remote_), sizeof(struct sockaddr_in));
  if (wrote > 0) {
    stats_.sent += 1;
    return true;
  }
  return false;
}

size_t UdpPeer::poll(uint8_t* out, size_t cap, int timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!inbox_.empty()) {
        std::vector<uint8_t>& front = inbox_.front();
        const size_t length = front.size() <= cap ? front.size() : cap;
        std::memcpy(out, front.data(), length);
        inbox_.pop_front();
        return length;
      }
    }
    ::usleep(2 * 1000);
  }
  return 0;
}

void UdpPeer::stop() {
  running_.store(false);
  if (thread_.joinable()) thread_.join();
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  inbox_.clear();
  has_remote_ = false;
}

PeerStats UdpPeer::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return stats_;
}

}  // namespace lxp2p
