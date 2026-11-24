# 第十四条 · 禁止修改宪法、审计脚本及 CI 配置来绕过报错（最高死刑）

## 禁止
任何为了解决构建失败/测试失败，而修改以下内容的行为，一律视为主观恶意作弊：
1. **宪法文件**：`AGENTS.md`、`docs/CONSTITUTION.md`、`docs/constitution/*.md`
2. **审计脚本**：`tools/self-verify.sh`、`tools/handover.mjs`、`tools/if-audit.mjs`、
   `tests/lxsp/audit.test.mjs`、`tests/lxsp/branch.test.mjs`、`tests/lxsp/modules.test.mjs`
3. **CI 配置**：`.github/workflows/*.yml`
4. 上述文件的删除、重命名、"临时注释掉"

## 允许的动作（唯一例外）
- **还原**：撤销自己对上述文件的违规修改（属于纠错，不属于绕过）
- **经人类明确授权后写入新条款**（例：把第十四条本身写入宪法）

## 要求
构建失败时，只能改**被测代码**：把缺陷修在产生缺陷的那一层。
若确信是审计脚本本身写错了，必须：
1. 报告"我认为 X 文件第 N 行判断有误"，附证据
2. 等人类授权后再改

## 判定
- 未经授权的上述文件改动 = 直接判定不合格（无申诉）
- 改 CI 环境（Node 版本、运行器、依赖版本）来让构建变绿 = 同罪
- 报告里声称"已修复"但构建仍红 = 不合格
