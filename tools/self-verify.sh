#!/bin/sh
# 自证脚本（宪法第十二条）：一条命令跑完全部本地可执行验证
set -u

# Node 版本门禁（环境不满足时明确"未测"，而不是抛 .ts 扩展名错误）
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  echo "Node 版本门禁"
  echo "  当前: $(node -v)"
  echo "  需要: >=22.6（.ts 直跑依赖 strip-types）"
  echo "  结论: 未测（环境不满足）"
  exit 2
fi

cd "$(dirname "$0")/.." || exit 1
fail=0

echo "== 1/4 分支审计（禁止吞异常/静默 return）=="
node tools/if-audit.mjs | tail -3 || fail=1

echo "== 2/4 真实链路 + 全量测试 =="
node --import ./tests/lxsp/hook.mjs tests/lxsp/run.mjs 2>&1 | tail -3 || fail=1

echo "== 3/4 真机模拟闭环（真实端点/直链/故障注入）=="
node tools/device-sim.mjs | tail -8 || fail=1

echo "== 4/4 语法解析（全部改动文件）=="
node -e '
const { createRequire } = require("node:module")
const req = createRequire(process.cwd() + "/package.json")
let parser
try { parser = req("@babel/parser") } catch (e) { parser = require(process.env.HOME + "/parsecheck/node_modules/@babel/parser") }
const fs = require("fs")
const files = [
  "src/core/listen-together/service.ts",
  "src/core/listen-together/p2p-room.ts",
  "src/core/listen-together/telemetry.ts",
  "src/plugins/player/service.ts",
  "src/core/init/player/playProgress.ts",
  "src/screens/Home/Views/Setting/settings/Other/ListenTogether.tsx",
]
let bad = 0
for (const f of files) {
  try { parser.parse(fs.readFileSync(f, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] }) }
  catch (e) { bad++; console.log("  FAIL", f, e.message) }
}
console.log(bad === 0 ? "  OK 全部解析通过（" + files.length + " 个文件）" : "  FAIL " + bad + " 个文件")
process.exit(bad === 0 ? 0 : 1)
' || fail=1

echo
[ "$fail" = "0" ] && echo "SELF-VERIFY: PASS" || echo "SELF-VERIFY: FAIL"
exit "$fail"
