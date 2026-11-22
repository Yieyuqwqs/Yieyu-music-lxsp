// C++ 状态真源（M2 第一步）
//
// 设计：每个「域」（guard/version/player/setting/...）是一堆「字段 -> 原始 JSON 值」。
//   · TS 只发增量 patch（post 'state.patch'），C++ 合并后把整域快照推回 'core.state'；
//   · UI 侧的 store 对象退化成「镜像」，不再持有真源；
//   · 值以「原始 JSON 文本」保存（数字/布尔/字符串/对象/数组都原样），不需要强类型 schema，
//     避免为了迁移 17 个域先写 17 套数据结构。
//
// 锁规则：一把锁，方法之间不嵌套；const 方法里的计数器一律 mutable（坑 #53）。
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace yieyu {
namespace core {

class StateBox {
public:
    /** 合并一批字段；返回合并后的整域 JSON；失败返回空串 */
    std::string patch(const std::string& domain, const std::string& patchJson);
    /** 整域快照；域不存在返回 "{}" */
    std::string snapshot(const std::string& domain) const;
    /** 所有域的快照：{"domain":{...},...} */
    std::string snapshotAll() const;
    bool clear(const std::string& domain);

    std::string statsJson() const;

private:
    std::string snapshotLocked(const std::string& domain) const;   // 调用者需持锁

    mutable std::mutex mutex_;
    std::unordered_map<std::string, std::unordered_map<std::string, std::string>> domains_;
    mutable std::atomic<uint64_t> patches_{0};
    mutable std::atomic<uint64_t> fields_{0};
    mutable std::atomic<uint64_t> errors_{0};
};

}  // namespace core
}  // namespace yieyu
