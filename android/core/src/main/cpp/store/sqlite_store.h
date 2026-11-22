// C++ 侧持久化：SQLite（M1b）
//
// 为什么现在才上 SQLite：M1a 的行式文本存大歌单会把整个文件读进内存，
// 且 >64KB 的值只能不镜像；SQLite 用 BLOB 直接吃 MB 级数据，还自带事务/索引/崩溃恢复。
//
// 锁规则（本文件只有一个锁，故意做成「无嵌套」；任何调用方都不得持有 core 的锁再进来）：
//   · 所有公开方法只拿 mutex_，内部不再调用任何会取锁的函数；
//   · 统计计数器全部 mutable（const 方法里也要自增）；
//   · 任何 sqlite3_* 调用都在这把锁之内完成，绝不持有锁去回调 Java。
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

struct sqlite3;
struct sqlite3_stmt;

namespace yieyu {
namespace core {

class SqliteStore {
public:
    bool open(const std::string& dir);
    void close();

    // 单值上限 16MB（大歌单/封面 base64 都够）；超过直接拒绝，绝不让 JS 把内存打爆
    bool put(const std::string& key, const std::string& value);
    bool get(const std::string& key, std::string* out) const;
    bool remove(const std::string& key);
    void compact();
    /** 前缀扫描（用于启动时把 state:* 全捞回来） */
    bool scanPrefix(const std::string& prefix, std::vector<std::pair<std::string, std::string>>* out) const;

    std::string statsJson() const;
    bool opened() const { return opened_; }

private:
    void importLegacyTextFile(const std::string& dir, int* imported, int* skipped);
    void flushStats();

    mutable std::mutex mutex_;
    sqlite3* db_ = nullptr;
    bool opened_ = false;
    std::string dir_;
    std::string path_;

    // 计数器：get()/statsJson() 是 const，所以要 mutable（坑 #53）
    mutable std::atomic<uint64_t> writes_{0};
    mutable std::atomic<uint64_t> reads_{0};
    mutable std::atomic<uint64_t> removes_{0};
    mutable std::atomic<uint64_t> errors_{0};
    mutable std::atomic<uint64_t> imports_{0};
    mutable std::atomic<uint64_t> bytesWritten_{0};
    mutable std::atomic<uint64_t> lastWriteUs_{0};
    mutable std::atomic<int64_t> entries_{0};
    mutable std::atomic<int64_t> totalBytes_{0};
};

}  // namespace core
}  // namespace yieyu
