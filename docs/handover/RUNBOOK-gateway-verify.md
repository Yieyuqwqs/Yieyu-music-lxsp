# 运维手册 · 音源网关验收入口

> 网关代码：`~/lx-server/server.js`（本机），鉴权键在 `src/config/defaultSetting.ts` 与网关两侧。

---

## 一、必查四步

```bash
# 0. 启动
cd ~/lx-server && node server.js &

# 1. 鉴权必须真实生效：无 key → 401
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:1101/api/v0/url/kw/62355680/320k"

# 2. 带 key → 200 且返回直链
curl -s -H "X-Api-Key: <KEY>" "http://127.0.0.1:1101/api/v0/url/kw/62355680/320k"

# 3. 直链必须能取到音频字节（这是最终判据）
curl -s -H "Range: bytes=0-1023" "<直链>" -o /tmp/a.bin \
     -w "http=%{http_code} bytes=%{size_download} type=%{content_type}\n"
xxd /tmp/a.bin | head -3

# 4. 写进 fixture（供 CI 的真实链路用例）
cd <repo> && node tools/pipeline-check.mjs "<直链>"
```

**通过标准**：`206`（或 `200`）+ `audio/mpeg`（或 `audio/flac`）+ 音频头（`ff fb` / `49 44 33` / `66 4c 61 43`）+ 字节数 > 1024。

---

## 二、失败样本与含义（实测）

| 结果 | 含义 | 处理 |
|---|---|---|
| `403` + `text/html` + `<center>nginx</center>` | CDN 拒绝（签名过期 / 绑定来源） | 网关重新签发；不要靠加 UA/Referer 绕过（实测无效） |
| `410` + `0` 字节 | 资源已下线/超时 | 换音质或换源；记录 provider 名称 |
| `200` + `text/html` | 返回了错误页而不是音频 | 网关把错误页当成功，需要改判定 |
| `0` 字节 + `content-type` 空 | 连接被掐/超时 | 检查出网、DNS、TLS |

---

## 三、网关侧的三个怀疑点（按优先级）

1. **签名时间窗**：链接里带时间戳/签名，缓存复用必然过期 → 禁止缓存 `url` 响应，或 TTL ≤ 5 分钟
2. **provider 返回空流**：某些歌曲在某些音质下 provider 直接给空，网关需要回落到下一音质
3. **音质阶梯未生效**：`320k` 失败应自动降 `128k`，而不是把失败当成功返回

---

## 四、不要做的事

- 不要为了“让 App 能播”而在 App 层加二次请求/探针（已判定为补丁，见交接文档）
- 不要把网关返回的错误页当成功（`200 + text/html` 必须判失败）
- 不要修改 CI 配置来跳过真实链路用例
