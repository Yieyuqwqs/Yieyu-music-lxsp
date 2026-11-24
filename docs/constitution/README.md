# 宪法 · 总表

十条铁律，逐条拆成独立文件。任何代码改动都必须通过这十条；违反任一条 = 交付不合格。

| # | 条款 | 一句话 | 文件 | 强制方式 |
|---|---|---|---|---|
| 1 | 禁止补丁式开发 | 改机制，不改表象 | [01-no-patching.md](./01-no-patching.md) | 评审 + 改动清单 |
| 2 | 修复四件套 | 根因/不变量/测试/回退 | [02-four-parts.md](./02-four-parts.md) | 每次修复必填 |
| 3 | 状态只有一个来源 | 谁拥有谁写，别人只读校验 | [03-single-source-of-truth.md](./03-single-source-of-truth.md) | 审计测试 |
| 4 | 引用必须验证 | 定义/import/调用三处都在 | [04-verify-references.md](./04-verify-references.md) | 契约测试 + grep |
| 5 | 性能必须带实测 | min/P50/P90/max + 样本数 | [05-measured-performance.md](./05-measured-performance.md) | 报告格式 |
| 6 | 构建失败只修根因 | 不绕、不屏蔽 | [06-fix-root-cause-only.md](./06-fix-root-cause-only.md) | 编译门禁 |
| 7 | 不留临时方案 | TODO 本次内解决或删除 | [07-no-temporary-hacks.md](./07-no-temporary-hacks.md) | 评审 |
| 8 | 诚实高于好看 | 分清实测/理论/未接上 | [08-honesty-first.md](./08-honesty-first.md) | 报告格式 |
| 9 | 改动清单纪律 | 先发清单再写代码 | [09-change-list.md](./09-change-list.md) | 报告前置 |
| 10 | CI 必须解析到每个模块 | 禁止覆盖死区、禁止正则批量改 | [10-no-dead-zone.md](./10-no-dead-zone.md) | modules.test.mjs |
| 11 | 严禁温室测试 | Mock 不算通过；要真链路/真数据/真日志 | [11-no-greenhouse-testing.md](./11-no-greenhouse-testing.md) | live.test.mjs + 豁免标注 |

## 执行顺序（每次改动）

1. 读总表，确认本次改动触及哪几条
2. **先发改动清单**（第九条），标注每处 `if`/`try`/常量的性质
3. 写代码 → 跑 `npm run test:lxsp`（102 项）
4. 跑分支审计 `node tools/if-audit.mjs`，硬违规必须 0
5. 附延迟表（第五条），分清实测/理论
6. 推送并触发构建

## 判定失败的情形

- 出现"吞异常 / 静默 return / 改阈值绕过时序"
- 测试全绿但真机崩（说明死区）
- 报告里把"理论"说成"实测"
- 用正则批量改写源码
