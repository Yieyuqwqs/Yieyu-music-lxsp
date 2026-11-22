#include "state_box.h"

#include <android/log.h>

#include <cctype>
#include <cstdio>

#define LOG_TAG "YieyuCoreState"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace yieyu {
namespace core {
namespace {

void skipWs(const std::string& s, size_t* i) {
    while (*i < s.size() && std::isspace(static_cast<unsigned char>(s[*i]))) (*i)++;
}

// 从 i 处解析一个 JSON 值，返回其原始文本（含对象/数组的完整括号）
bool readValue(const std::string& s, size_t* i, std::string* out) {
    skipWs(s, i);
    if (*i >= s.size()) return false;
    const size_t begin = *i;
    const char ch = s[*i];
    if (ch == '"') {
        (*i)++;
        while (*i < s.size()) {
            const char c = s[*i];
            if (c == '\\') { *i += 2; continue; }
            (*i)++;
            if (c == '"') break;
        }
    } else if (ch == '{' || ch == '[') {
        int depth = 0;
        bool inString = false;
        while (*i < s.size()) {
            const char c = s[*i];
            if (inString) {
                if (c == '\\') { *i += 2; continue; }
                if (c == '"') inString = false;
            } else if (c == '"') {
                inString = true;
            } else if (c == '{' || c == '[') {
                depth++;
            } else if (c == '}' || c == ']') {
                depth--;
                if (depth == 0) { (*i)++; break; }
            }
            (*i)++;
        }
    } else {
        // 数字 / true / false / null
        while (*i < s.size()) {
            const char c = s[*i];
            if (c == ',' || c == '}' || std::isspace(static_cast<unsigned char>(c))) break;
            (*i)++;
        }
    }
    if (*i == begin) return false;
    out->assign(s, begin, *i - begin);
    return true;
}

// 解析扁平 JSON 对象 -> (字段, 原始值文本)
bool splitObject(const std::string& json, std::vector<std::pair<std::string, std::string>>* out) {
    size_t i = 0;
    skipWs(json, &i);
    if (i >= json.size() || json[i] != '{') return false;
    i++;
    while (true) {
        skipWs(json, &i);
        if (i >= json.size()) return false;
        if (json[i] == '}') return true;
        if (json[i] == ',') { i++; continue; }
        if (json[i] != '"') return false;
        size_t begin = i;
        std::string keyRaw;
        if (!readValue(json, &i, &keyRaw)) return false;
        // 去掉两侧引号并反转义（只处理 \\ 和 \"）
        std::string key;
        for (size_t k = 1; k + 1 < keyRaw.size(); k++) {
            if (keyRaw[k] == '\\' && k + 2 < keyRaw.size()) {
                const char esc = keyRaw[k + 1];
                if (esc == '"' || esc == '\\') { key += esc; k++; continue; }
            }
            key += keyRaw[k];
        }
        skipWs(json, &i);
        if (i >= json.size() || json[i] != ':') return false;
        i++;
        std::string value;
        if (!readValue(json, &i, &value)) return false;
        out->emplace_back(std::move(key), std::move(value));
        (void)begin;
    }
}

}  // namespace

std::string StateBox::patch(const std::string& domain, const std::string& patchJson) {
    if (domain.empty()) return std::string();
    std::vector<std::pair<std::string, std::string>> fields;
    if (!splitObject(patchJson, &fields)) {
        errors_.fetch_add(1);
        LOGE("patch parse failed: domain=%s", domain.c_str());
        return std::string();
    }
    std::lock_guard<std::mutex> lock(mutex_);
    auto& bucket = domains_[domain];
    for (auto& entry : fields) {
        if (entry.first.empty()) continue;
        bucket[entry.first] = std::move(entry.second);
        fields_.fetch_add(1);
    }
    patches_.fetch_add(1);
    return snapshotLocked(domain);
}

std::string StateBox::snapshotLocked(const std::string& domain) const {
    std::string out = "{";
    auto it = domains_.find(domain);
    if (it == domains_.end()) return out + "}";
    bool first = true;
    for (const auto& entry : it->second) {
        if (!first) out += ',';
        first = false;
        out += '"';
        out += entry.first;      // 字段名来自我们自己的 JS 侧，不含需要转义的字符
        out += "\":";
        out += entry.second;
    }
    out += '}';
    return out;
}

std::string StateBox::snapshot(const std::string& domain) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return snapshotLocked(domain);
}

std::string StateBox::snapshotAll() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::string out = "{";
    bool first = true;
    for (const auto& domain : domains_) {
        if (!first) out += ',';
        first = false;
        out += '"';
        out += domain.first;
        out += "\":";
        out += snapshotLocked(domain.first);
    }
    out += '}';
    return out;
}

bool StateBox::clear(const std::string& domain) {
    std::lock_guard<std::mutex> lock(mutex_);
    return domains_.erase(domain) > 0;
}

std::string StateBox::statsJson() const {
    std::lock_guard<std::mutex> lock(mutex_);
    size_t domainCount = 0, totalFields = 0;
    for (const auto& d : domains_) { domainCount++; totalFields += d.second.size(); }
    char buf[256];
    std::snprintf(buf, sizeof(buf),
                  "\"stateDomains\":%zu,\"stateFields\":%zu,\"statePatches\":%llu,\"stateErrors\":%llu",
                  domainCount, totalFields,
                  static_cast<unsigned long long>(patches_.load()),
                  static_cast<unsigned long long>(errors_.load()));
    return std::string(buf);
}

}  // namespace core
}  // namespace yieyu
