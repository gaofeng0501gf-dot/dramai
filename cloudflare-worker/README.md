# dramai-kling-proxy

Kling 官方 API 的 CORS 安全中转（Cloudflare Worker）。

浏览器不能直接调用 `https://api-singapore.klingai.com`（CORS 拦截），而且真正的 Kling API Key 也不该放在浏览器里。这个 Worker 解决这两件事：

```
https://gaofeng0501gf-dot.github.io/dramai/      （浏览器，只知道 PROXY_TOKEN）
        │  Authorization: Bearer <PROXY_TOKEN>
        ▼
https://dramai-kling-proxy.<account-subdomain>.workers.dev   （本 Worker）
        │  校验 Origin、路径、PROXY_TOKEN
        │  Authorization 换成 Bearer <KLING_API_KEY>
        ▼
https://api-singapore.klingai.com                （Kling 官方）
```

dramai 的 Kling Omni 协议完全不变，Worker 只做透传。

## 安全规则

| 规则       | 行为                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游       | 固定为 `https://api-singapore.klingai.com`，不能被请求改写                                                                                                                         |
| Origin     | 只允许 `https://gaofeng0501gf-dot.github.io`；其他 Origin（包括没有 Origin 的 curl 请求）返回 **403**                                                                              |
| 接口白名单 | `GET /account/costs`、`POST /v1/videos/omni-video`、`GET /v1/videos/omni-video/{task_id}`；其他路径或方法返回 **404**                                                              |
| 预检       | `OPTIONS` 返回 204，带 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods: GET,POST,OPTIONS`、`Access-Control-Allow-Headers: Authorization,Content-Type`、`Vary: Origin` |
| 代理口令   | `Authorization` 必须严格等于 `Bearer <PROXY_TOKEN>`（常量时间比较），否则 **401**                                                                                                  |
| 上游鉴权   | 转发时 `Authorization` 替换为 `Bearer <KLING_API_KEY>`                                                                                                                             |
| 请求转发   | 保留 path、query string、POST body（逐字节不改）、`Content-Type`；不转发 `Host`、`Content-Length`、`Cookie`、`Origin` 等                                                           |
| 响应       | 原样返回 Kling 的 HTTP 状态码和响应体，只带回 `Content-Type` 与 CORS 头                                                                                                            |
| 日志       | Worker 不打印任何内容，`wrangler.toml` 也关闭了日志采集                                                                                                                            |

`/account/costs` 是 Kling 免费的账户资源查询，dramai 的「测试连接」只调用它，不提交视频任务，不产生视频费用。

## 需要你亲自设置的两个 Secret

| 名称            | 内容                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `KLING_API_KEY` | 你在 Kling Open Platform 拿到的真正 API Key。**只存在 Cloudflare 里**，不要填进 dramai，也不要提交到任何仓库 |
| `PROXY_TOKEN`   | 你自己生成的一串随机口令，dramai 浏览器页面用它访问 Worker。可以用 `openssl rand -hex 32` 生成               |

两者都只用 `wrangler secret put` 设置（加密保存），绝不写进 `wrangler.toml` 或代码。

## 部署步骤

需要本机装有 Node.js 20+，以及一个 Cloudflare 账号（免费版即可）。

```bash
# 0. 进入本目录
cd cloudflare-worker

# 1. 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 2. 设置真正的 Kling API Key（命令执行后按提示粘贴，输入不会显示、不会进入 shell 历史）
npx wrangler secret put KLING_API_KEY

# 3. 设置浏览器侧使用的代理口令（粘贴你自己生成的随机串）
npx wrangler secret put PROXY_TOKEN

# 4. 部署
npx wrangler deploy
```

首次执行 `secret put` 时如果 Worker 还不存在，wrangler 会提示是否新建，选择 Yes 即可；也可以先执行一次 `npx wrangler deploy` 再设置 Secret。

部署成功后，wrangler 会输出 Worker 地址：

```
https://dramai-kling-proxy.<account-subdomain>.workers.dev
```

`<account-subdomain>` 是你 Cloudflare 账号的 workers.dev 子域名（首次使用 Workers 时在 Cloudflare 后台设置）。

### 部署后自检（可选，不产生费用）

浏览器以外的请求没有允许的 Origin，会被 403 拦截，这是预期行为。下面这条用于确认白名单和 Origin 校验已生效：

```bash
curl -i https://dramai-kling-proxy.<account-subdomain>.workers.dev/account/costs
# 预期：HTTP/2 403  {"error":"origin_not_allowed"}
```

真正的连通性请在 dramai 页面里点「测试连接」验证。

## 在 dramai 里怎么填

部署完成后，在 dramai 的「设置 → 服务商」里新建（或编辑）Kling 3.0 Omni Provider：

| 字段         | 填写                                                         |
| ------------ | ------------------------------------------------------------ |
| 服务类型     | 图生视频                                                     |
| API 协议风格 | **Kling Omni 原生**                                          |
| Base URL     | `https://dramai-kling-proxy.<account-subdomain>.workers.dev` |
| API Key      | 你设置的 **`PROXY_TOKEN`**（不是 Kling 的 Key）              |
| 模型名       | `kling-v3-omni`                                              |

保存后点「测试连接」：会经 Worker 调用免费的 `/account/costs`，显示「连接 OK」即说明 Base URL、PROXY_TOKEN、Kling API Key 和 CORS 全部正常。

**真正的 `KLING_API_KEY` 不再填写到 dramai 浏览器页面。** 如果以前在 dramai 里填过 Kling 的真 Key，请把那一栏改成 `PROXY_TOKEN`。

## 注意事项

- 只有 `https://gaofeng0501gf-dot.github.io` 下的页面能用这个 Worker。本地 `npm run dev`（`http://localhost:5173`）会被 403 拒绝，这是有意的；本地调试 Kling 时请改用部署好的页面。
- 如果怀疑 `PROXY_TOKEN` 泄露，重新执行 `npx wrangler secret put PROXY_TOKEN` 换一个即可，旧口令立刻失效；Kling 的真 Key 不受影响。
- 本地测试：在仓库根目录执行 `npm test`（会一起跑 Worker 的测试），或单独执行 `node --test "cloudflare-worker/test/*.test.mjs"`。测试里的上游请求都是假实现，不访问网络。
