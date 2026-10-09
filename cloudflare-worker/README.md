# dramai-kling-proxy

Kling 官方 API 的 CORS 安全中转（Cloudflare Worker）。当前部署已验证使用 Beijing 上游。

浏览器不能直接调用 `https://api-beijing.klingai.com`（CORS 拦截），而且真正的 Kling API Key 也不该放在浏览器里。这个 Worker 解决这两件事：

```
https://gaofeng0501gf-dot.github.io/dramai/      （浏览器，只知道 PROXY_TOKEN）
        │  Authorization: Bearer <PROXY_TOKEN>
        ▼
https://dramai-kling-proxy.<account-subdomain>.workers.dev   （本 Worker）
        │  校验 Origin、路径、PROXY_TOKEN
        │  Authorization 换成 Bearer <KLING_API_KEY>
        ▼
https://api-beijing.klingai.com                （Kling 官方）
```

dramai 的 Kling Omni **视频API协议保持原样**。本版新增私有R2临时图片代理：前端逐张上传PNG/JPEG至R2，再通过不含Base64的短JSON把图片URL提交给 Kling，避免重复发送约23MB请求。

## 安全规则

| 规则       | 行为                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游       | 固定为 `https://api-beijing.klingai.com`，不能被请求改写                                                                                                                         |
| Origin     | API与图片上传/删除只允许 `https://gaofeng0501gf-dot.github.io`；仅临时图片的GET/HEAD允许Kling服务端无Origin读取                                                                              |
| 接口白名单 | 原有三个Kling代理路径，外加`GET /v1/omni-assets/status`、`POST /v1/omni-assets`、临时图片GET/HEAD及授权DELETE；其余仍拒绝                                                              |
| 预检       | `OPTIONS` 返回 204，带 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods: GET,POST,OPTIONS`、`Access-Control-Allow-Headers: Authorization,Content-Type`、`Vary: Origin` |
| 代理口令   | `Authorization` 必须严格等于 `Bearer <PROXY_TOKEN>`（常量时间比较），否则 **401**                                                                                                  |
| 上游鉴权   | 转发时 `Authorization` 替换为 `Bearer <KLING_API_KEY>`                                                                                                                             |
| 请求转发   | 保留 path、query string、POST body（逐字节不改）、`Content-Type`；不转发 `Host`、`Content-Length`、`Cookie`、`Origin` 等                                                           |
| 响应       | 原样返回 Kling 的 HTTP 状态码和响应体，只带回 `Content-Type` 与 CORS 头                                                                                                            |
| 日志       | 只记录阶段、耗时、HTTP状态码和传输字节数，不记录任何Token、提示词、图片原文、URL随机片段                                                                                                                            |

`/account/costs` 是 Kling 免费的账户资源查询，dramai 的「测试连接」只调用它，不提交视频任务，不产生视频费用。

## 新增：必须先创建私有R2存储桶及绑定

本升级不是只替换 Worker JS 就能生效。操作人必须在 Cloudflare 仪表板完成以下设置：

1. 进入 **R2 Object Storage → Overview → Create bucket**（部分界面可能要求开通R2服务），名称必须为 **`dramai-omni-assets`**。
2. **不要启用公开桶地址**，也不需要公共 `r2.dev` 域名。图片只能经现有 Worker 的随机临时URL读取。
3. 进入 **Workers & Pages → dramai-kling-proxy → Settings → Bindings → Add binding → R2 bucket**；变量名填 **`OMNI_ASSETS`**，选择桶 `dramai-omni-assets`，保存/部署。
4. 为 R2 桶设置 **Object Lifecycle 自动删除规则：`omni/` 前缀对象创建后2天删除**（UI的生命周期天数颗粒度可能为整数天）。代码层另有24小时严格读取过期校验，生命周期仅负责物理清理。
5. 重新部署本仓库 `cloudflare-worker/src/index.js` 的完整新代码（已有密钥不会因此需要更换）。

如果使用 Wrangler，`wrangler.toml` 已含 `[[r2_buckets]] binding = "OMNI_ASSETS"`；但 **Cloudflare网页编辑并不会自动读取 GitHub 中的 wrangler.toml**，因此网页部署仍需按第3步手动绑定。

上传接口只接受 `image/png` 和 `image/jpeg`，每张小于或等于10MiB、需要浏览器提供Content-Length；每个返回的随机图片URL **24小时后自动失效**。可灵官方对参考图还有尺寸及长宽比限制，前端不会偷偷压缩、更改你的锁定角色图。如原图不合规，应先以明确可控方式准备合规素材。

### 零视频费用验收

在 dramai → 设置 → Kling 3.0 Omni 卡片：

- **测试连接**：原有 `GET /account/costs` 仅检验可灵连接。
- **测试R2图片传输（不生成视频）**：依次探测R2绑定、上传一个内置极小测试PNG、通过临时URL读取、授权删除。全过程不会调用 `/v1/videos/omni-video`；R2可能产生极少量存储/操作计费，实际以你的Cloudflare账户为准。

通过这两项后，再确认历史可灵账单/任务中没有未处理的提交，才可手动解除dramai的旧“提交状态未知”锁并尝试一次正式视频生成。

重要：不要把R2 bucket设为公开读，也不要在聊天里提供密钥或带随机令牌的具体临时图片链接。

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

保存后先点「测试连接」确认可灵账户查询，再点「测试R2图片传输（不生成视频）」确认新存储链路。只通过前者不代表R2已经绑定好。

**真正的 `KLING_API_KEY` 不再填写到 dramai 浏览器页面。** 如果以前在 dramai 里填过 Kling 的真 Key，请把那一栏改成 `PROXY_TOKEN`。

## 技术边界与安全

- 浏览器不再把参考图转换成 Base64 提交给可灵：**每张原图先经带鉴权的Worker上传R2，最终Kling JSON只包含对应随机HTTPS图片URL**；人物/场景参考顺序不变。
- 只对精确匹配 `https://dramai-kling-proxy.gaofeng0501gf.workers.dev` 的视频服务使用R2流程，其他官方直连或不同中转继续使用原Base64兼容模式。R2失败绝不自动退回大请求。
- 图片临时URL属于随机访问能力凭证：任何持有URL的服务器都可能在有效期内读取，请防止泄露；到期代码即拒绝读取。可灵抓图实际时间必须在24小时内。
- 已经向可灵发出的视频POST即使网络超时也可能已创建任务；**禁止自动重试**。R2图片上传阶段失败可以在核验后重试，因为此时尚未发送可灵POST。
- Worker CORS/Origin限制只用于上传、删除及API；可灵远端下载临时图片无浏览器Origin头，GET/HEAD因此必须允许无Origin，但不支持目录列举。
- **生产验收还需要一次真实的Kling请求才能最终证明可灵能够抓取临时URL**，这一步可能扣费，不纳入“免费测试”。
- R2服务是否需要账户计费验证或支付方式，取决于当前Cloudflare账号及地区。创建存储桶前先查看Cloudflare的计费说明。

## 注意事项

- 只有 `https://gaofeng0501gf-dot.github.io` 下的页面能用这个 Worker。本地 `npm run dev`（`http://localhost:5173`）会被 403 拒绝，这是有意的；本地调试 Kling 时请改用部署好的页面。
- 如果怀疑 `PROXY_TOKEN` 泄露，重新执行 `npx wrangler secret put PROXY_TOKEN` 换一个即可，旧口令立刻失效；Kling 的真 Key 不受影响。
- 本地测试：在仓库根目录执行 `npm test`（会一起跑 Worker 的测试），或单独执行 `node --test "cloudflare-worker/test/*.test.mjs"`。测试里的上游请求都是假实现，不访问网络。
