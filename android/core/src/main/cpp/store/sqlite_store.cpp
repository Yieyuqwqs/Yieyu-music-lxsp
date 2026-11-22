#include "sqlite_store.h"

#include <android/log.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <vector>

#include "sqlite3.h"

#define LOG_TAG "YieyuCoreDb"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace yieyu {
namespace core {
namespace {

constexpr size_t kMaxValueBytes = 16 * 1024 * 1024;   // 16MB：大歌单够用，又不至于让 JNI 传爆
constexpr int kSchemaVersion = 1;

uint64_t nowUs() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

int64_t nowMs() {
    return static_cast<int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

bool exec(sqlite3* db, const char* sql) {
    char* err = nullptr;
    if (sqlite3_exec(db, sql, nullptr, nullptr, &err) != SQLITE_OK) {
        LOGE("exec failed: %s | sql=%.80s", err ? err : "?", sql);
        if (err != nullptr) sqlite3_free(err);
        return false;
    }
    return true;
}

// ---- 旧格式（M1a 的 kv.txt：key<TAB>base64(value)）导入 ----
const char kBase64Chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

bool base64Decode(const std::string& in, std::string* out) {
    static int8_t table[256];
    static bool inited = false;
    if (!inited) {
        for (int i = 0; i < 256; i++) table[i] = -1;
        for (int i = 0; i < 64; i++) table[static_cast<uint8_t>(kBase64Chars[i])] = static_cast<int8_t>(i);
        inited = true;
    }
    out->clear();
    out->reserve(in.size() / 4 * 3);
    uint32_t buffer = 0;
    int bits = 0;
    for (char c : in) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        const int8_t v = table[static_cast<uint8_t>(c)];
        if (v < 0) return false;
        buffer = (buffer << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<char>((buffer >> bits) & 0xff));
        }
    }
    return true;
}

}  // namespace

bool SqliteStore::open(const std::string& dir) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (opened_) return true;
    dir_ = dir;
    path_ = dir + "/core.db";
    ::mkdir(dir_.c_str(), 0700);

    if (sqlite3_open_v2(path_.c_str(), &db_,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                        nullptr) != SQLITE_OK) {
        LOGE("open failed: %s", db_ ? sqlite3_errmsg(db_) : "null");
        if (db_ != nullptr) { sqlite3_close(db_); db_ = nullptr; }
        errors_.fetch_add(1);
        return false;
    }

    sqlite3_busy_timeout(db_, 2000);
    exec(db_, "PRAGMA journal_mode=WAL;");
    exec(db_, "PRAGMA synchronous=NORMAL;");
    exec(db_, "PRAGMA temp_store=MEMORY;");
    exec(db_, "PRAGMA foreign_keys=ON;");

    if (!exec(db_, "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);")) return false;
    if (!exec(db_,
              "CREATE TABLE IF NOT EXISTS kv ("
              " key TEXT PRIMARY KEY,"
              " value BLOB NOT NULL,"
              " bytes INTEGER NOT NULL,"
              " updated_at INTEGER NOT NULL);")) return false;
    if (!exec(db_, "CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv(updated_at);")) return false;

    char version[32];
    std::snprintf(version, sizeof(version), "%d", kSchemaVersion);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "INSERT INTO meta(k,v) VALUES('schema',?1) "
                                "ON CONFLICT(k) DO UPDATE SET v=excluded.v;", -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, version, -1, SQLITE_TRANSIENT);
        sqlite3_step(stmt);
    }
    if (stmt != nullptr) sqlite3_finalize(stmt);

    opened_ = true;

    int imported = 0, skipped = 0;
    importLegacyTextFile(dir_, &imported, &skipped);
    if (imported > 0 || skipped > 0) {
        LOGI("legacy kv.txt imported: %d (skipped %d)", imported, skipped);
        imports_.fetch_add(static_cast<uint64_t>(imported));
        const std::string legacy = dir_ + "/kv.txt";
        const std::string migrated = dir_ + "/kv.txt.imported";
        std::rename(legacy.c_str(), migrated.c_str());
    }

    LOGI("sqlite opened: %s", path_.c_str());
    return true;
}

void SqliteStore::importLegacyTextFile(const std::string& dir, int* imported, int* skipped) {
    const std::string legacy = dir + "/kv.txt";
    FILE* file = std::fopen(legacy.c_str(), "rb");
    if (file == nullptr) return;   // 没有旧数据是正常的（新安装）

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_,
                           "INSERT INTO kv(key,value,bytes,updated_at) VALUES(?1,?2,?3,?4) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value, bytes=excluded.bytes, "
                           "updated_at=excluded.updated_at;", -1, &stmt, nullptr) != SQLITE_OK) {
        std::fclose(file);
        return;
    }
    exec(db_, "BEGIN;");
    std::vector<char> line(8192);
    int ok = 0, bad = 0;
    // 长行（大歌单）可能超过 8KB：fgets 会分多次返回，这里按「读整行」拼接
    std::string current;
    bool eof = false;
    while (!eof) {
        if (std::fgets(line.data(), static_cast<int>(line.size()), file) == nullptr) {
            eof = true;
            if (current.empty()) break;
        } else {
            current += line.data();
            if (current.empty() || current.back() != '\n') continue;   // 行还没读完
        }
        while (!current.empty() && (current.back() == '\n' || current.back() == '\r')) current.pop_back();
        const size_t tab = current.find('\t');
        if (tab != std::string::npos) {
            std::string value;
            if (base64Decode(current.substr(tab + 1), &value)) {
                const std::string key = current.substr(0, tab);
                sqlite3_bind_text(stmt, 1, key.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_blob(stmt, 2, value.data(), static_cast<int>(value.size()), SQLITE_TRANSIENT);
                sqlite3_bind_int64(stmt, 3, static_cast<sqlite3_int64>(value.size()));
                sqlite3_bind_int64(stmt, 4, nowMs());
                if (sqlite3_step(stmt) == SQLITE_DONE) ok++; else bad++;
                sqlite3_reset(stmt);
                sqlite3_clear_bindings(stmt);
            } else bad++;
        }
        current.clear();
    }
    sqlite3_finalize(stmt);
    std::fclose(file);
    exec(db_, "COMMIT;");
    if (imported != nullptr) *imported = ok;
    if (skipped != nullptr) *skipped = bad;
    entries_.fetch_add(ok);
}

bool SqliteStore::put(const std::string& key, const std::string& value) {
    if (key.empty() || value.size() > kMaxValueBytes) {
        errors_.fetch_add(1);
        return false;
    }
    const uint64_t begin = nowUs();
    std::lock_guard<std::mutex> lock(mutex_);
    if (!opened_ || db_ == nullptr) return false;

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_,
                           "INSERT INTO kv(key,value,bytes,updated_at) VALUES(?1,?2,?3,?4) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                           "bytes=excluded.bytes, updated_at=excluded.updated_at;", -1, &stmt, nullptr)
        != SQLITE_OK) {
        errors_.fetch_add(1);
        return false;
    }
    sqlite3_bind_text(stmt, 1, key.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_blob(stmt, 2, value.data(), static_cast<int>(value.size()), SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 3, static_cast<sqlite3_int64>(value.size()));
    sqlite3_bind_int64(stmt, 4, nowMs());
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (!ok) {
        errors_.fetch_add(1);
        LOGE("put failed: %s", sqlite3_errmsg(db_));
        return false;
    }
    writes_.fetch_add(1);
    bytesWritten_.fetch_add(value.size());
    lastWriteUs_.store(nowUs() - begin);
    return true;
}

bool SqliteStore::get(const std::string& key, std::string* out) const {
    std::lock_guard<std::mutex> lock(mutex_);
    reads_.fetch_add(1);
    if (!opened_ || db_ == nullptr) return false;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "SELECT value FROM kv WHERE key=?1;", -1, &stmt, nullptr) != SQLITE_OK) {
        errors_.fetch_add(1);
        return false;
    }
    sqlite3_bind_text(stmt, 1, key.c_str(), -1, SQLITE_TRANSIENT);
    bool found = false;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        const void* blob = sqlite3_column_blob(stmt, 0);
        const int size = sqlite3_column_bytes(stmt, 0);
        if (out != nullptr) out->assign(static_cast<const char*>(blob), static_cast<size_t>(size > 0 ? size : 0));
        found = true;
    }
    sqlite3_finalize(stmt);
    return found;
}

bool SqliteStore::remove(const std::string& key) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!opened_ || db_ == nullptr) return false;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "DELETE FROM kv WHERE key=?1;", -1, &stmt, nullptr) != SQLITE_OK) {
        errors_.fetch_add(1);
        return false;
    }
    sqlite3_bind_text(stmt, 1, key.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    const bool changed = sqlite3_changes(db_) > 0;
    sqlite3_finalize(stmt);
    if (changed) removes_.fetch_add(1);
    return changed;
}

bool SqliteStore::scanPrefix(const std::string& prefix, std::vector<std::pair<std::string, std::string>>* out) const {
    std::lock_guard<std::mutex> lock(mutex_);
    reads_.fetch_add(1);
    if (!opened_ || db_ == nullptr || out == nullptr) return false;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "SELECT key, value FROM kv WHERE key LIKE ?1 ORDER BY key;", -1, &stmt, nullptr) != SQLITE_OK) {
        errors_.fetch_add(1);
        return false;
    }
    const std::string pattern = prefix + "%";
    sqlite3_bind_text(stmt, 1, pattern.c_str(), -1, SQLITE_TRANSIENT);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char* key = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        const void* blob = sqlite3_column_blob(stmt, 1);
        const int size = sqlite3_column_bytes(stmt, 1);
        if (key == nullptr) continue;
        out->emplace_back(std::string(key),
                          std::string(static_cast<const char*>(blob), static_cast<size_t>(size > 0 ? size : 0)));
    }
    sqlite3_finalize(stmt);
    return true;
}

void SqliteStore::compact() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!opened_ || db_ == nullptr) return;
    exec(db_, "PRAGMA wal_checkpoint(TRUNCATE);");
    exec(db_, "VACUUM;");
    LOGI("vacuum done");
}

void SqliteStore::flushStats() {
    // 调用者需持锁
    entries_.store(0);
    totalBytes_.store(0);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM kv;", -1, &stmt, nullptr) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            entries_.store(sqlite3_column_int64(stmt, 0));
            totalBytes_.store(sqlite3_column_int64(stmt, 1));
        }
        sqlite3_finalize(stmt);
    }
}

std::string SqliteStore::statsJson() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (opened_ && db_ != nullptr) const_cast<SqliteStore*>(this)->flushStats();
    char buf[512];
    std::snprintf(buf, sizeof(buf),
                  "\"dbOpened\":%s,\"dbEntries\":%lld,\"dbBytes\":%lld,\"dbWrites\":%llu,\"dbReads\":%llu,"
                  "\"dbRemoves\":%llu,\"dbErrors\":%llu,\"dbImported\":%llu,\"dbBytesWritten\":%llu,"
                  "\"dbLastWriteUs\":%llu,\"dbSchema\":%d",
                  opened_ ? "true" : "false",
                  static_cast<long long>(entries_.load()),
                  static_cast<long long>(totalBytes_.load()),
                  static_cast<unsigned long long>(writes_.load()),
                  static_cast<unsigned long long>(reads_.load()),
                  static_cast<unsigned long long>(removes_.load()),
                  static_cast<unsigned long long>(errors_.load()),
                  static_cast<unsigned long long>(imports_.load()),
                  static_cast<unsigned long long>(bytesWritten_.load()),
                  static_cast<unsigned long long>(lastWriteUs_.load()),
                  kSchemaVersion);
    return std::string(buf);
}

void SqliteStore::close() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (db_ != nullptr) {
        sqlite3_wal_checkpoint(db_, nullptr);
        sqlite3_close(db_);
        db_ = nullptr;
    }
    opened_ = false;
    LOGI("sqlite closed");
}

}  // namespace core
}  // namespace yieyu
