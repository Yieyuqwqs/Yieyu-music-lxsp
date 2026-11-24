#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace lxp2p {

/**
 * 一起听同步引擎（纯 C++）
 *
 * 为什么放原生：
 *  - JS 的 setTimeout 在主线程忙时会晚 10–50ms，而这里是独立线程 + 单调时钟，误差 <1ms
 *  - 播放头计算完全在原生做，跨桥只拿一个数字
 *
 * 职责：
 *  1. 维护锚点（positionMs / anchorMonoMs / isPlaying）
 *  2. 给出当前播放头（单调时钟，纳秒精度）
 *  3. 按绝对单调时间调度命令（到点回调，不依赖 JS 定时器）
 */
class SyncEngine {
 public:
  using Clock = std::chrono::steady_clock;

  static SyncEngine& instance();

  void set_anchor(int64_t position_ms, int64_t anchor_mono_us, bool playing);
  int64_t playhead_ms() const;
  /** 距离锚点生效还剩多少毫秒（负数=已生效） */
  int64_t lead_remaining_ms() const;
  /** 在单调时刻（相对现在 +delay_ms）触发一个命令 id */
  void schedule(int32_t command_id, int32_t delay_ms);
  void cancel(int32_t command_id);
  /** 取走所有到期命令（Java 线程会轮询它） */
  std::vector<int32_t> take_due();
  void clear();

 private:
  SyncEngine() = default;
  mutable std::mutex mutex_;
  int64_t position_ms_ = 0;
  int64_t anchor_mono_us_ = 0;
  bool playing_ = false;
  struct Pending { int32_t id; int64_t due_us; };
  std::vector<Pending> pending_;
};

int64_t now_mono_us();

}  // namespace lxp2p
