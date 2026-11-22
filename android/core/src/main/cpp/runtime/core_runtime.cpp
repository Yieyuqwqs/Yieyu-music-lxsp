#include "core_runtime.h"

#include <android/log.h>
#include <pthread.h>

#include <cstdio>
#include <cstring>
#include <utility>

#define LOG_TAG "YieyuCore"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace yieyu {
namespace core {

namespace {

constexpr const char* kVersion = "0.1.0-m0";

uint64_t nowMs() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

uint64_t nowUs() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

void setThreadName(const char* name) {
    pthread_setname_np(pthread_self(), name);
}

// 极简 JSON 字符串转义（只处理必须转义的字符，避免引入第三方库）
std::string jsonEscape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// 线程级 JNI 环境守卫：构造 Attach、析构 Detach（异常路径也保证配对）
class JniThreadScope {
public:
    explicit JniThreadScope(JavaVM* vm) : vm_(vm) {
        if (vm_ == nullptr) return;
        if (vm_->GetEnv(reinterpret_cast<void**>(&env_), JNI_VERSION_1_6) == JNI_OK) {
            attached_ = false;   // 已经是 Java 线程（JS 线程），不需要 detach
            return;
        }
        if (vm_->AttachCurrentThread(&env_, nullptr) == JNI_OK) attached_ = true;
    }
    ~JniThreadScope() {
        if (attached_ && vm_ != nullptr) vm_->DetachCurrentThread();
    }
    JNIEnv* env() const { return env_; }

private:
    JavaVM* vm_ = nullptr;
    JNIEnv* env_ = nullptr;
    bool attached_ = false;
};

bool jsonStrField(const std::string& json, const char* field, std::string* out) {
    const std::string needle = std::string("\"") + field + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return false;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    if (pos >= json.size() || json[pos] != '"') return false;
    pos++;
    std::string value;
    while (pos < json.size()) {
        const char ch = json[pos++];
        if (ch == '"') { *out = std::move(value); return true; }
        if (ch == '\\' && pos < json.size()) {
            const char esc = json[pos++];
            switch (esc) {
                case 'n': value += '\n'; break;
                case 'r': value += '\r'; break;
                case 't': value += '\t'; break;
                case 'b': value += '\b'; break;
                case 'f': value += '\f'; break;
                case 'u': value += '?'; if (pos + 4 <= json.size()) pos += 4; break;
                default: value += esc;
            }
        } else {
            value += ch;
        }
    }
    return false;
}

}  // namespace

Runtime& Runtime::instance() {
    static Runtime runtime;
    return runtime;
}

// ---------------------------------------------------------------- 生命周期

void Runtime::ensureStarted(JNIEnv* env, jobject host) {
    if (env == nullptr || host == nullptr) return;

    // RN reload / 多实例会把宿主换成新的 CoreModule。
    // 旧宿主必须整块作废（否则事件会永远打到死掉的 ReactContext 上 —— 见 §9.2 第 4 条）。
    {
        std::lock_guard<std::mutex> lock(hostMutex_);
        if (ready_.load(std::memory_order_acquire) && host_ != nullptr &&
            env->IsSameObject(host_, host)) {
            return;
        }
    }
    if (ready_.load(std::memory_order_acquire)) {
        LOGI("host changed, rebuilding core runtime");
        stop();
    }

    std::lock_guard<std::mutex> lock(hostMutex_);
    if (ready_.load(std::memory_order_acquire)) return;

    env->GetJavaVM(&vm_);
    if (vm_ == nullptr) {
        LOGE("GetJavaVM failed");
        return;
    }

    host_ = env->NewGlobalRef(host);
    if (host_ == nullptr) {
        LOGE("NewGlobalRef failed");
        return;
    }
    globalRefs_.fetch_add(1);

    jclass cls = env->GetObjectClass(host_);
    midEvent_ = env->GetMethodID(cls, "onEvent", "(Ljava/lang/String;Ljava/lang/String;)V");
    midResponse_ = env->GetMethodID(cls, "onResponse", "(JLjava/lang/String;)V");
    env->DeleteLocalRef(cls);
    if (midEvent_ == nullptr || midResponse_ == nullptr) {
        if (env->ExceptionCheck()) env->ExceptionClear();
        LOGE("CoreCallback methods not found");
        env->DeleteGlobalRef(host_);
        host_ = nullptr;
        globalRefs_.fetch_sub(1);
        return;
    }

    startedAtMs_.store(nowMs());
    stopping_.store(false);
    running_.store(true);
    ready_.store(true, std::memory_order_release);
    generation_.fetch_add(1);

    if (!storageDir_.empty() && !db_.opened()) {
        db_.open(storageDir_);   // reload / stop 之后自愈
    }

    commandThread_ = std::thread([this] { this->commandLoop(); });
    dispatchThread_ = std::thread([this] { this->dispatchLoop(); });

    LOGI("core started generation=%llu version=%s",
         static_cast<unsigned long long>(generation()), kVersion);
}

void Runtime::stop() {
    // 注意：这里绝不能持有 hostMutex_ 去 join —— dispatch 线程的 deliver() 也要拿 hostMutex_，
    // 一旦队列里还有事件就会死锁（M0 自审发现的第一个真实 bug）。
    if (!running_.exchange(false)) return;
    stopping_.store(true);

    { std::lock_guard<std::mutex> l(cmdMutex_); cmdCv_.notify_all(); }
    { std::lock_guard<std::mutex> l(evMutex_); evCv_.notify_all(); }

    if (commandThread_.joinable()) commandThread_.join();
    if (dispatchThread_.joinable()) dispatchThread_.join();

    {
        std::lock_guard<std::mutex> l(cmdMutex_);
        cmdQueue_.clear();
    }
    {
        std::lock_guard<std::mutex> l(evMutex_);
        evQueue_.clear();
        subscriptions_.clear();
    }

    db_.close();   // checkpoint + 释放

    std::lock_guard<std::mutex> lock(hostMutex_);
    JniThreadScope scope(vm_);
    if (scope.env() != nullptr && host_ != nullptr) {
        scope.env()->DeleteGlobalRef(host_);
        globalRefs_.fetch_sub(1);
    }
    host_ = nullptr;
    midEvent_ = nullptr;
    midResponse_ = nullptr;
    ready_.store(false, std::memory_order_release);
    generation_.fetch_add(1);
    LOGI("core stopped generation=%llu", static_cast<unsigned long long>(generation()));
}

// ---------------------------------------------------------------- 入队（JS 线程）

bool Runtime::post(const std::string& op, const std::string& payload, double seq) {
    if (!running_.load(std::memory_order_acquire)) return false;
    const uint64_t begin = nowUs();
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        if (cmdQueue_.size() >= kCommandQueueMax) {
            commandsDropped_.fetch_add(1);
            return false;
        }
        Command cmd;
        cmd.op = op;
        cmd.payload = payload;
        cmd.seq = seq;
        cmd.requestId = -1;
        cmdQueue_.push_back(std::move(cmd));
        commandsIn_.fetch_add(1);
    }
    cmdCv_.notify_one();
    lastEnqueueUs_.store(nowUs() - begin);
    return true;
}

void Runtime::request(const std::string& op, const std::string& payload, jlong id) {
    if (!running_.load(std::memory_order_acquire)) return;
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        if (cmdQueue_.size() >= kCommandQueueMax) {
            commandsDropped_.fetch_add(1);
            return;
        }
        Command cmd;
        cmd.op = op;
        cmd.payload = payload;
        cmd.seq = 0;
        cmd.requestId = id;
        cmdQueue_.push_back(std::move(cmd));
        commandsIn_.fetch_add(1);
    }
    cmdCv_.notify_one();
}

void Runtime::subscribe(const std::string& topic, jint maxHz) {
    std::lock_guard<std::mutex> lock(evMutex_);
    if (subscriptions_.size() >= static_cast<size_t>(kMaxSubscriptionCount) &&
        subscriptions_.find(topic) == subscriptions_.end()) {
        return;
    }
    subscriptions_[topic] = { maxHz < 0 ? 0 : maxHz, 0 };
}

void Runtime::unsubscribe(const std::string& topic) {
    std::lock_guard<std::mutex> lock(evMutex_);
    subscriptions_.erase(topic);
}

void Runtime::setForeground(bool foreground) {
    foreground_.store(foreground);
}

void Runtime::setStorageDir(const std::string& dir) {
    // 只允许在命令线程/初始化线程调用：db_.open() 会读盘
    storageDir_ = dir;
    db_.open(dir);
    // M3：启动水合 —— 把上次退出时落库的每个域捞回 StateBox（C++ 才是真源）
    {
        std::vector<std::pair<std::string, std::string>> rows;
        if (db_.scanPrefix("state:", &rows)) {
            for (auto& row : rows) {
                const std::string domain = row.first.substr(6);
                state_.patch(domain, row.second);
            }
            LOGI("state hydrated: %zu domains", rows.size());
            if (!rows.empty()) {
                emit("core.state.bulk", state_.snapshotAll());   // 主动推，杜绝与 TS 请求的竞态
            }
        }
    }
    emit("db.ready", "{\"dir\":\"" + jsonEscape(dir) + "\"}");
}

// ---------------------------------------------------------------- 事件

bool Runtime::emitLocked(const Event& event) {
    const int64_t now = static_cast<int64_t>(nowMs());
    auto it = subscriptions_.find(event.topic);
    if (it != subscriptions_.end()) {
        const int maxHz = it->second.first;
        if (maxHz > 0) {
            const int64_t minGap = 1000 / maxHz;
            if (now - it->second.second < minGap) {
                eventsThrottled_.fetch_add(1);
                return false;   // 覆盖式丢旧：状态类事件天然幂等
            }
            it->second.second = now;
        }
    }
    if (evQueue_.size() >= kEventQueueMax) {
        evQueue_.pop_front();          // 有界：丢最旧的，绝不无限增长
        eventsDropped_.fetch_add(1);
    }
    evQueue_.push_back(event);
    eventsIn_.fetch_add(1);
    return true;
}

void Runtime::emit(const std::string& topic, const std::string& json) {
    if (!running_.load(std::memory_order_acquire)) return;
    bool queued = false;
    {
        std::lock_guard<std::mutex> lock(evMutex_);
        queued = emitLocked(Event{topic, json});
    }
    if (queued) evCv_.notify_one();
}

// ---------------------------------------------------------------- 线程

void Runtime::commandLoop() {
    setThreadName("core-cmd");
    JniThreadScope scope(vm_);
    while (true) {
        Command cmd;
        {
            std::unique_lock<std::mutex> lock(cmdMutex_);
            cmdCv_.wait(lock, [this] { return !running_.load() || !cmdQueue_.empty(); });
            if (!running_.load() && cmdQueue_.empty()) return;
            if (cmdQueue_.empty()) continue;
            cmd = std::move(cmdQueue_.front());
            cmdQueue_.pop_front();
        }
        commandsHandled_.fetch_add(1);
        handle(cmd);
    }
}

void Runtime::dispatchLoop() {
    setThreadName("core-disp");
    JniThreadScope scope(vm_);
    while (true) {
        Event event;
        {
            std::unique_lock<std::mutex> lock(evMutex_);
            evCv_.wait(lock, [this] { return !running_.load() || !evQueue_.empty(); });
            if (evQueue_.empty()) {
                if (!running_.load()) return;
                continue;
            }
            event = std::move(evQueue_.front());
            evQueue_.pop_front();
        }
        deliver(event);
    }
}

void Runtime::deliver(const Event& event) {
    if (event.topic == "core.error") {
        LOGE("%s", event.json.c_str());
    }
    JniThreadScope scope(vm_);
    JNIEnv* env = scope.env();
    if (env == nullptr) return;

    jobject host = nullptr;
    jmethodID method = nullptr;
    {
        std::lock_guard<std::mutex> lock(hostMutex_);
        host = host_;
        method = midEvent_;
    }
    if (host == nullptr || method == nullptr) return;

    const uint64_t begin = nowUs();
    env->PushLocalFrame(8);
    jstring jtopic = env->NewStringUTF(event.topic.c_str());
    jstring jjson = env->NewStringUTF(event.json.c_str());
    if (jtopic != nullptr && jjson != nullptr) {
        env->CallVoidMethod(host, method, jtopic, jjson);
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
            deliverErrors_.fetch_add(1);
        } else {
            eventsOut_.fetch_add(1);
        }
    } else if (env->ExceptionCheck()) {
        env->ExceptionClear();
        deliverErrors_.fetch_add(1);
    }
    env->PopLocalFrame(nullptr);
    lastDeliverUs_.store(nowUs() - begin);
}

// ---------------------------------------------------------------- 命令处理

void Runtime::handle(const Command& cmd) {
    if (cmd.op == "core.ping") {
        char buf[256];
        std::snprintf(buf, sizeof(buf), "{\"seq\":%.0f,\"echo\":\"%s\",\"ts\":%llu}",
                      cmd.seq, jsonEscape(cmd.payload).c_str(),
                      static_cast<unsigned long long>(nowMs()));
        emit("core.pong", buf);
        if (cmd.requestId >= 0) {
            JniThreadScope scope(vm_);
            if (scope.env() != nullptr) {
                std::lock_guard<std::mutex> lock(hostMutex_);
                if (host_ != nullptr && midResponse_ != nullptr) {
                    jstring j = scope.env()->NewStringUTF(buf);
                    scope.env()->CallVoidMethod(host_, midResponse_, cmd.requestId, j);
                    scope.env()->DeleteLocalRef(j);
                    if (scope.env()->ExceptionCheck()) scope.env()->ExceptionClear();
                }
            }
        }
        return;
    }

    if (cmd.op == "core.selftest" || cmd.op == "core.stats") {
        const std::string report = stats();
        emit("core.selftest", report);
        if (cmd.requestId >= 0) {
            JniThreadScope scope(vm_);
            JNIEnv* env = scope.env();
            if (env != nullptr) {
                std::lock_guard<std::mutex> lock(hostMutex_);
                if (host_ != nullptr && midResponse_ != nullptr) {
                    jstring j = env->NewStringUTF(report.c_str());
                    env->CallVoidMethod(host_, midResponse_, cmd.requestId, j);
                    env->DeleteLocalRef(j);
                    if (env->ExceptionCheck()) env->ExceptionClear();
                }
            }
        }
        return;
    }

    if (cmd.op == "kv.set" || cmd.op == "kv.get" || cmd.op == "kv.remove" || cmd.op == "kv.flush") {
        std::string key, value;
        const bool hasKey = jsonStrField(cmd.payload, "k", &key);
        std::string reply;
        bool ok = false;
        if (cmd.op == "kv.set") {
            const bool hasValue = jsonStrField(cmd.payload, "v", &value);
            ok = hasKey && hasValue && db_.put(key, value);
            reply = std::string("{\"k\":\"") + jsonEscape(key) + "\",\"ok\":" + (ok ? "true" : "false") + "}";
            if (ok) emit("kv.changed", reply);
        } else if (cmd.op == "kv.get") {
            std::string stored;
            const bool found = hasKey && db_.get(key, &stored);
            ok = found;
            if (found && stored.size() > 1024 * 1024) {
                // 大值不回传：16MB 的字符串过 JNI 会瞬间吃掉几十 MB 内存
                reply = std::string("{\"k\":\"") + jsonEscape(key) + "\",\"found\":true,\"size\":" +
                        std::to_string(stored.size()) + ",\"omitted\":true}";
            } else {
                reply = std::string("{\"k\":\"") + jsonEscape(key) + "\",\"found\":" +
                        (found ? "true" : "false") + ",\"v\":\"" + jsonEscape(stored) + "\"}";
            }
        } else if (cmd.op == "kv.remove") {
            ok = hasKey && db_.remove(key);
            reply = std::string("{\"k\":\"") + jsonEscape(key) + "\",\"ok\":" + (ok ? "true" : "false") + "}";
        } else {
            db_.compact();
            ok = true;
            reply = db_.statsJson();
        }
        if (cmd.requestId >= 0) {
            JniThreadScope scope(vm_);
            JNIEnv* env = scope.env();
            if (env != nullptr) {
                std::lock_guard<std::mutex> lock(hostMutex_);
                if (host_ != nullptr && midResponse_ != nullptr) {
                    jstring j = env->NewStringUTF(reply.c_str());
                    env->CallVoidMethod(host_, midResponse_, cmd.requestId, j);
                    env->DeleteLocalRef(j);
                    if (env->ExceptionCheck()) env->ExceptionClear();
                }
            }
        }
        return;
    }

    if (cmd.op == "state.patch" || cmd.op == "state.get" || cmd.op == "state.all" || cmd.op == "state.clear") {
        std::string domain, patchJson, reply;
        if (cmd.op == "state.all") {
            reply = state_.snapshotAll();
        } else {
            const bool hasDomain = jsonStrField(cmd.payload, "d", &domain);
            if (!hasDomain) {
                reply = "{\"error\":\"missing_domain\"}";
            } else if (cmd.op == "state.clear") {
                state_.clear(domain);
                db_.remove("state:" + domain);
                reply = state_.snapshot(domain);
            } else if (cmd.op == "state.get") {
                reply = state_.snapshot(domain);
            } else {
                const bool hasPatch = jsonStrField(cmd.payload, "p", &patchJson);
                reply = hasPatch ? state_.patch(domain, patchJson) : std::string();
                if (!reply.empty()) {
                    // M3：状态耐久化 —— 每次 patch 都落 SQLite（同一次写入，不额外开事务）
                    db_.put("state:" + domain, reply);
                    // 推给 JS：整域快照（UI 侧只做镜像覆盖）
                    emit("core.state", std::string("{\"d\":\"") + jsonEscape(domain) + "\",\"s\":" + reply + "}");
                }
            }
        }
        if (!reply.empty() && cmd.requestId >= 0) {
            JniThreadScope scope(vm_);
            JNIEnv* env = scope.env();
            if (env != nullptr) {
                std::lock_guard<std::mutex> lock(hostMutex_);
                if (host_ != nullptr && midResponse_ != nullptr) {
                    jstring j = env->NewStringUTF(reply.c_str());
                    env->CallVoidMethod(host_, midResponse_, cmd.requestId, j);
                    env->DeleteLocalRef(j);
                    if (env->ExceptionCheck()) env->ExceptionClear();
                }
            }
        }
        return;
    }

    if (cmd.op == "core.stop") {
        emit("core.stopping", "{}");
        return;   // 真正停止由 Java 侧 nativeStop() 触发，避免在命令线程里 join 自己
    }

    // 未实现：诚实报错，不吞
    std::string err = "{\"op\":\"";
    err += jsonEscape(cmd.op);
    err += "\",\"code\":\"UNKNOWN_OP\"}";
    emit("core.error", err);
}

// ---------------------------------------------------------------- 统计

std::string Runtime::stats() const {
    char buf[1024];
    std::size_t cmdQueueSize = 0;
    { std::lock_guard<std::mutex> cmdLock(cmdMutex_); cmdQueueSize = cmdQueue_.size(); }
    std::lock_guard<std::mutex> lock(evMutex_);
    std::snprintf(buf, sizeof(buf),
                  "{\"version\":\"%s\",\"generation\":%llu,\"uptimeMs\":%llu,"
                  "\"commandsIn\":%llu,\"commandsHandled\":%llu,\"commandsDropped\":%llu,"
                  "\"eventsIn\":%llu,\"eventsOut\":%llu,\"eventsDropped\":%llu,"
                  "\"eventsThrottled\":%llu,\"deliverErrors\":%llu,"
                  "\"queueCmds\":%zu,\"queueEvents\":%zu,\"cmdCap\":%zu,\"evCap\":%zu,"
                  "\"globalRefs\":%d,\"subscriptions\":%zu,\"lastEnqueueUs\":%llu,\"lastDeliverUs\":%llu}",
                  kVersion,
                  static_cast<unsigned long long>(generation()),
                  static_cast<unsigned long long>(nowMs() - startedAtMs_.load()),
                  static_cast<unsigned long long>(commandsIn_.load()),
                  static_cast<unsigned long long>(commandsHandled_.load()),
                  static_cast<unsigned long long>(commandsDropped_.load()),
                  static_cast<unsigned long long>(eventsIn_.load()),
                  static_cast<unsigned long long>(eventsOut_.load()),
                  static_cast<unsigned long long>(eventsDropped_.load()),
                  static_cast<unsigned long long>(eventsThrottled_.load()),
                  static_cast<unsigned long long>(deliverErrors_.load()),
                  cmdQueueSize, evQueue_.size(), kCommandQueueMax, kEventQueueMax,
                  globalRefs_.load(), subscriptions_.size(),
                  static_cast<unsigned long long>(lastEnqueueUs_.load()),
                  static_cast<unsigned long long>(lastDeliverUs_.load()));
    std::string report(buf);
    const std::string dbStats = db_.statsJson();
    const std::string stateStats = state_.statsJson();
    if (!dbStats.empty() || !stateStats.empty()) {
        report.pop_back();          // 去掉结尾的 '}'
        if (!dbStats.empty()) { report += ","; report += dbStats; }
        if (!stateStats.empty()) { report += ","; report += stateStats; }
        report += "}";
    }
    return report;
}

}  // namespace core
}  // namespace yieyu
