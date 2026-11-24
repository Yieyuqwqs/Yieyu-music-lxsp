#pragma once

#include <cstdint>
#include <string>

namespace lxp2p {

struct StunResult {
  bool ok = false;
  std::string ip;
  uint16_t port = 0;
  std::string error;
};

/**
 * 发一个 STUN Binding Request（RFC 5389），从响应里取 XOR-MAPPED-ADDRESS。
 * 只做 IPv4（手机蜂窝/WiFi 基本都有 v4；v6 先不折腾）。
 */
StunResult stun_discover(const char* host, uint16_t port, int timeout_ms);

/** 兜底：拿本机的私网地址（打洞失败时给信令对端一个提示） */
std::string local_ipv4();

}  // namespace lxp2p
