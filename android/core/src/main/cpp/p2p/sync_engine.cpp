#include "sync_engine.h"

namespace lxp2p {

int64_t now_mono_us() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             SyncEngine::Clock::now().time_since_epoch())
      .count();
}

SyncEngine& SyncEngine::instance() {
  static SyncEngine engine;
  return engine;
}

void SyncEngine::set_anchor(int64_t position_ms, int64_t anchor_mono_us, bool playing) {
  std::lock_guard<std::mutex> lock(mutex_);
  position_ms_ = position_ms < 0 ? 0 : position_ms;
  anchor_mono_us_ = anchor_mono_us;
  playing_ = playing;
}

int64_t SyncEngine::playhead_ms() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!playing_) return position_ms_;
  const int64_t elapsed_us = now_mono_us() - anchor_mono_us_;
  if (elapsed_us <= 0) return position_ms_;
  return position_ms_ + elapsed_us / 1000;
}

int64_t SyncEngine::lead_remaining_ms() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return (anchor_mono_us_ - now_mono_us()) / 1000;
}

void SyncEngine::schedule(int32_t command_id, int32_t delay_ms) {
  std::lock_guard<std::mutex> lock(mutex_);
  pending_.push_back({command_id, now_mono_us() + static_cast<int64_t>(delay_ms) * 1000});
}

void SyncEngine::cancel(int32_t command_id) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto it = pending_.begin(); it != pending_.end();) {
    if (it->id == command_id) it = pending_.erase(it);
    else ++it;
  }
}

std::vector<int32_t> SyncEngine::take_due() {
  std::vector<int32_t> due;
  const int64_t now = now_mono_us();
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto it = pending_.begin(); it != pending_.end();) {
    if (it->due_us <= now) {
      due.push_back(it->id);
      it = pending_.erase(it);
    } else {
      ++it;
    }
  }
  return due;
}

void SyncEngine::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  pending_.clear();
  position_ms_ = 0;
  anchor_mono_us_ = 0;
  playing_ = false;
}

}  // namespace lxp2p
