// Yieyu Core Runtime（M0 地基）
//
// 设计铁律（对应 ARCH_FAT_CORE.md §4）：
//   1. 所有 JNI 入口必须 <0.5ms 返回：只做「拷贝 + 入队」。
//   2. C++ 绝不从音频线程回调 JS；所有事件走唯一 Dispatch 线程。
//   3. 队列有界 + 按 topic 限频，绝不无限堆积。
//   4. 宿主（Java CoreModule）用 GlobalRef 持有，并由 generation 防止 reload 后回调死对象。
#pragma once

#include <jni.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

#include "state/state_box.h"
#include "store/sqlite_store.h"

namespace yieyu {
namespace core {

// ============================ 锁与 const 的硬规矩（坑 #51~53 的疫苗） ============================
// 1. 本文件只有两把锁：hostMutex_（宿主/方法 ID）与 evMutex_（事件队列）。
//    cmdMutex_ 只在命令队列里用，且**从不**在持有它的同时去拿 evMutex_ / hostMutex_。
// 2. 固定锁序：evMutex_  →  hostMutex_   （stats() 是 cmdMutex_ → evMutex_，仍然单向）
//    任何地方都不允许反向，否则就是死锁。
// 3. **持锁期间绝不 join 线程**、绝不做磁盘/网络 IO。stop() 就是踩过这个坑：
//    先置标志 → notify → join（不持锁）→ 再持锁释放 GlobalRef。
// 4. 所有「const 方法里也要改」的成员一律 mutable（mutex / 统计计数器）。
// ============================================================================================

constexpr std::size_t kCommandQueueMax = 256;
constexpr std::size_t kEventQueueMax = 1024;
constexpr int kMaxSubscriptionCount = 64;

struct Event {
    std::string topic;
    std::string json;
};

class Runtime {
public:
    static Runtime& instance();

    // ---- JNI 入口（JS 线程）----
    void ensureStarted(JNIEnv* env, jobject host);
    bool post(const std::string& op, const std::string& payload, double seq);
    void request(const std::string& op, const std::string& payload, jlong id);
    void subscribe(const std::string& topic, jint maxHz);
    void unsubscribe(const std::string& topic);
    void setForeground(bool foreground);
    void setStorageDir(const std::string& dir);
    void stop();

    // ---- 内部 / 任意线程 ----
    void emit(const std::string& topic, const std::string& json);
    std::string stats() const;

    bool ready() const { return ready_.load(std::memory_order_acquire); }
    uint64_t generation() const { return generation_.load(std::memory_order_acquire); }
    void noteGlobalRef(jint delta) { globalRefs_.fetch_add(delta); }

private:
    Runtime() = default;
    Runtime(const Runtime&) = delete;
    Runtime& operator=(const Runtime&) = delete;

    struct Command {
        std::string op;
        std::string payload;
        double seq = 0;
        jlong requestId = -1;
    };

    void startLocked(JNIEnv* env, jobject host);
    void teardownLocked(JNIEnv* env);
    void commandLoop();
    void dispatchLoop();
    void handle(const Command& cmd);
    bool emitLocked(const Event& event);   // 调用者需持 evMutex_
    void deliver(const Event& event);

    // 宿主
    JavaVM* vm_ = nullptr;
    jobject host_ = nullptr;               // GlobalRef
    jmethodID midEvent_ = nullptr;
    jmethodID midResponse_ = nullptr;
    std::atomic<uint64_t> generation_{0};
    std::atomic<int32_t> globalRefs_{0};

    std::mutex hostMutex_;
    std::atomic<bool> ready_{false};
    std::atomic<bool> running_{false};
    std::atomic<bool> stopping_{false};

    // 命令队列
    mutable std::mutex cmdMutex_;   // stats() 是 const，需要 mutable
    std::condition_variable cmdCv_;
    std::deque<Command> cmdQueue_;
    std::thread commandThread_;

    // 事件队列
    mutable std::mutex evMutex_;
    std::condition_variable evCv_;
    std::deque<Event> evQueue_;
    std::thread dispatchThread_;

    // 订阅限频
    std::unordered_map<std::string, std::pair<int, int64_t>> subscriptions_;  // topic -> (maxHz, lastMs)
    std::atomic<bool> foreground_{true};

    // M1b：SQLite 持久化（BLOB，单值上限 16MB；大歌单就靠它）
    SqliteStore db_;
    StateBox state_;   // M2：状态真源（TS 只保留镜像）
    std::string storageDir_;   // 记住存储目录：stop 后重启要能自己把 DB 重新打开

    // 统计
    std::atomic<uint64_t> startedAtMs_{0};
    std::atomic<uint64_t> commandsIn_{0};
    std::atomic<uint64_t> commandsDropped_{0};
    std::atomic<uint64_t> commandsHandled_{0};
    std::atomic<uint64_t> eventsIn_{0};
    std::atomic<uint64_t> eventsOut_{0};
    std::atomic<uint64_t> eventsDropped_{0};
    std::atomic<uint64_t> eventsThrottled_{0};
    std::atomic<uint64_t> deliverErrors_{0};
    std::atomic<uint64_t> lastDeliverUs_{0};
    std::atomic<uint64_t> lastEnqueueUs_{0};
};

}  // namespace core
}  // namespace yieyu
