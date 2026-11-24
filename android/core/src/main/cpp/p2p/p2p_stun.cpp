#include "p2p_stun.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <random>

namespace lxp2p {
namespace {

constexpr uint16_t kBindingRequest = 0x0001;
constexpr uint32_t kMagicCookie = 0x2112A442u;
constexpr uint16_t kAttrXorMapped = 0x0020;
constexpr uint16_t kAttrMapped = 0x0001;

void put16(uint8_t* p, uint16_t v) { p[0] = static_cast<uint8_t>(v >> 8); p[1] = static_cast<uint8_t>(v & 0xff); }
void put32(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>((v >> 24) & 0xff);
  p[1] = static_cast<uint8_t>((v >> 16) & 0xff);
  p[2] = static_cast<uint8_t>((v >> 8) & 0xff);
  p[3] = static_cast<uint8_t>(v & 0xff);
}
uint16_t get16(const uint8_t* p) { return static_cast<uint16_t>((p[0] << 8) | p[1]); }
uint32_t get32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

}  // namespace

StunResult stun_discover(const char* host, uint16_t port, int timeout_ms) {
  StunResult result;
  struct addrinfo hints {};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo* info = nullptr;
  char service[8];
  std::snprintf(service, sizeof(service), "%u", static_cast<unsigned>(port));
  if (::getaddrinfo(host, service, &hints, &info) != 0 || info == nullptr) {
    result.error = "resolve failed";
    return result;
  }

  int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) {
    ::freeaddrinfo(info);
    result.error = "socket failed";
    return result;
  }
  struct timeval tv {};
  tv.tv_sec = timeout_ms / 1000;
  tv.tv_usec = (timeout_ms % 1000) * 1000;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

  uint8_t request[20];
  std::memset(request, 0, sizeof(request));
  put16(request + 0, kBindingRequest);
  put16(request + 2, 0);  // length
  put32(request + 4, kMagicCookie);
  std::random_device rd;
  std::mt19937 gen(rd());
  for (int i = 8; i < 20; i++) request[i] = static_cast<uint8_t>(gen() & 0xff);

  if (::sendto(fd, request, sizeof(request), 0, info->ai_addr, info->ai_addrlen) < 0) {
    ::close(fd);
    ::freeaddrinfo(info);
    result.error = "send failed";
    return result;
  }

  uint8_t buffer[512];
  const ssize_t received = ::recv(fd, buffer, sizeof(buffer), 0);
  ::close(fd);
  ::freeaddrinfo(info);
  if (received < 20) {
    result.error = "stun timeout";
    return result;
  }
  if (get32(buffer + 4) != kMagicCookie) {
    result.error = "bad cookie";
    return result;
  }

  const uint16_t attr_len = get16(buffer + 2);
  size_t offset = 20;
  const size_t end = 20 + attr_len;
  while (offset + 4 <= end && offset + 4 <= static_cast<size_t>(received)) {
    const uint16_t type = get16(buffer + offset);
    const uint16_t len = get16(buffer + offset + 2);
    if (offset + 4 + len > static_cast<size_t>(received)) break;
    if (type == kAttrXorMapped || type == kAttrMapped) {
      const uint8_t family = buffer[offset + 5];
      if (family == 0x01) {  // IPv4
        uint32_t addr = get32(buffer + offset + 8);
        uint16_t port_value = get16(buffer + offset + 6);
        if (type == kAttrXorMapped) {
          addr ^= kMagicCookie;
          port_value ^= static_cast<uint16_t>(kMagicCookie >> 16);
        }
        struct in_addr in {};
        in.s_addr = htonl(addr);
        char text[INET_ADDRSTRLEN] = {0};
        ::inet_ntop(AF_INET, &in, text, sizeof(text));
        result.ok = true;
        result.ip = text;
        result.port = port_value;
        return result;
      }
    }
    offset += 4 + ((len + 3) & ~3u);
  }
  result.error = "no mapped address";
  return result;
}

std::string local_ipv4() {
  // 不用 getifaddrs（NDK 里按 API 级别有条件编译，容易踩坑）：
  // 连一个外部地址（UDP connect 不产生流量），再看本地 socket 地址即可
  int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return {};
  struct sockaddr_in probe {};
  probe.sin_family = AF_INET;
  probe.sin_port = htons(53);
  ::inet_pton(AF_INET, "223.5.5.5", &probe.sin_addr);  // 阿里 DNS
  std::string found;
  if (::connect(fd, reinterpret_cast<struct sockaddr*>(&probe), sizeof(probe)) == 0) {
    struct sockaddr_in local {};
    socklen_t len = sizeof(local);
    if (::getsockname(fd, reinterpret_cast<struct sockaddr*>(&local), &len) == 0) {
      char text[INET_ADDRSTRLEN] = {0};
      ::inet_ntop(AF_INET, &local.sin_addr, text, sizeof(text));
      found = text;
    }
  }
  ::close(fd);
  return found;
}

}  // namespace lxp2p
