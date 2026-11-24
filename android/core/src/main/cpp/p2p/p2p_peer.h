#pragma once

#include <sys/socket.h>
#include <sys/types.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace lxp2p {

struct PeerStats {
  uint32_t sent = 0;
  uint32_t received = 0;
  uint32_t dropped = 0;
  uint32_t keepalives = 0;
  int64_t last_rtt_us = 0;
  bool connected = false;
  std::string remote = "-";
};

/**
 * UDP 直连对端。
 *
 * 生命周期：start() → connect(remote) → send()/poll() → stop()
 * 设计取舍（性能优先）：
 *  - 收到就入队，不在接收线程里做业务，避免抖一帧
 *  - 去重窗口吞掉打洞阶段的重复包
 *  - 打洞期间每 200ms 发一个 keepalive，穿透 NAT 后自然停
 */
class UdpPeer {
 public:
  bool start(const char* stun_host, uint16_t stun_port, int timeout_ms, std::string& out_error);
  bool connect_to(const char* ip, uint16_t port);
  bool send_payload(const uint8_t* data, size_t size);
  /** 取一条消息（拷贝到 out）；没有就返回 0 */
  size_t poll(uint8_t* out, size_t cap, int timeout_ms);
  void stop();
  PeerStats stats() const;
  std::string mapped() const { return mapped_; }
  std::string private_ip() const { return private_ip_; }

 private:
  void recv_loop();
  void punch_once();

  int fd_ = -1;
  std::thread thread_;
  std::thread keepalive_thread_;
  void keepalive_loop();
  std::atomic<bool> running_{false};
  std::atomic<uint32_t> seq_{0};
  mutable std::mutex mutex_;
  std::deque<std::vector<uint8_t>> inbox_;
  struct sockaddr_storage remote_ {};
  bool has_remote_ = false;
  std::string mapped_;
  std::string private_ip_;
  PeerStats stats_;
};

}  // namespace lxp2p
