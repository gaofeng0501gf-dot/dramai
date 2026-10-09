/**
 * dramai-kling-proxy —— Kling 官方 API 的 CORS 安全中转（Cloudflare Worker）。
 *
 * 浏览器（GitHub Pages 上的 dramai）
 *   → 本 Worker（校验 Origin / 路径 / PROXY_TOKEN）
 *   → https://api-beijing.klingai.com（换成服务端的 KLING_API_KEY）
 *
 * Secrets（只用 `wrangler secret put` 设置，绝不写进仓库或 wrangler.toml）：
 *   KLING_API_KEY  真正的 Kling Open Platform API Key，只存在于 Worker 里
 *   PROXY_TOKEN    浏览器侧使用的代理口令，填在 dramai 的 API Key 一栏
 *
 * 仅记录安全的阶段/耗时/HTTP状态日志；绝不打印 Secret、请求体、提示词或图片。
 */

export const UPSTREAM = 'https://api-beijing.klingai.com'
export const ALLOWED_ORIGIN = 'https://gaofeng0501gf-dot.github.io'

const CORS_METHODS = 'GET,POST,OPTIONS'
const CORS_HEADERS = 'Authorization,Content-Type'
const TASK_PATH = /^\/v1\/videos\/omni-video\/[A-Za-z0-9._-]{1,128}$/

/**
 * 白名单：只放行 dramai Kling Omni 用到的三个接口。
 *   GET  /account/costs                    零费用账户资源查询（测试连接）
 *   POST /v1/videos/omni-video             提交 Omni 任务
 *   GET  /v1/videos/omni-video/{task_id}   轮询任务
 * 返回该路径允许的方法；不在白名单返回 null。
 */
export function allowedMethodFor(pathname) {
  if (pathname === '/account/costs') return 'GET'
  if (pathname === '/v1/videos/omni-video') return 'POST'
  if (TASK_PATH.test(pathname)) return 'GET'
  return null
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

/** 常量时间比较，避免通过响应时间猜测 PROXY_TOKEN。 */
export function timingSafeEqual(a, b) {
  const enc = new TextEncoder()
  const x = enc.encode(String(a))
  const y = enc.encode(String(b))
  let diff = x.length ^ y.length
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

/** 仅记录提交阶段，不记录身份、token、参考图、prompt 或请求体。 */
function trace(stage, route, startedAt, extra = {}) {
  console.info(JSON.stringify({ event: 'omni_proxy', stage, route, elapsedMs: Date.now() - startedAt, ...extra }))
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  })
}

/**
 * 处理一个请求。fetchImpl 可注入，便于本地单测；线上用全局 fetch。
 */
export async function handleRequest(request, env, fetchImpl = fetch) {
  const origin = request.headers.get('Origin')

  // 1. Origin：只允许 GitHub Pages 上的 dramai；没有 Origin 的请求（curl 等）也拒绝
  if (origin !== ALLOWED_ORIGIN) {
    return json(403, { error: 'origin_not_allowed' }, { Vary: 'Origin' })
  }
  const cors = corsHeaders(origin)

  // 2. 服务端配置不完整时直接失败（不泄露具体缺哪一项）
  if (!env || !env.KLING_API_KEY || !env.PROXY_TOKEN) {
    return json(500, { error: 'proxy_not_configured' }, cors)
  }

  const url = new URL(request.url)
  const allowed = allowedMethodFor(url.pathname)

  // 3. 预检
  if (request.method === 'OPTIONS') {
    if (!allowed) return json(404, { error: 'not_found' }, cors)
    return new Response(null, { status: 204, headers: cors })
  }

  // 4. 路径 + 方法白名单
  if (!allowed || request.method !== allowed) {
    return json(404, { error: 'not_found' }, cors)
  }

  // 5. 代理口令：必须严格等于 `Bearer ${PROXY_TOKEN}`
  const auth = request.headers.get('Authorization') ?? ''
  if (!timingSafeEqual(auth, `Bearer ${env.PROXY_TOKEN}`)) {
    return json(401, { error: 'unauthorized' }, cors)
  }

  // 6. 构造上游请求：固定上游域名，保留 path + query；只转发必要请求头
  const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${String(env.KLING_API_KEY).trim()}`)
  const contentType = request.headers.get('Content-Type')
  if (contentType) headers.set('Content-Type', contentType)
  const accept = request.headers.get('Accept')
  if (accept) headers.set('Accept', accept)
  // 不转发 Host / Content-Length / Cookie / Origin 等：由 fetch 按上游重新生成

  const startedAt = Date.now()
  const route = request.method === 'POST' ? 'submit' : url.pathname === '/account/costs' ? 'costs' : 'poll'
  const init = { method: request.method, headers }
  if (request.method === 'POST') {
    if (!request.body) return json(400, { error: 'missing_request_body' }, cors)
    // 关键修复：流式转发约23MB的Base64请求，不能 arrayBuffer() 整包读取。
    // duplex=half 兼容标准 Fetch 的 ReadableStream 请求体（含Node测试环境）。
    init.body = request.body
    init.duplex = 'half'
  }
  trace('forward_start', route, startedAt, {
    requestBytes: request.method === 'POST' ? Number(request.headers.get('Content-Length')) || null : null,
  })
  let upstream
  try {
    upstream = await fetchImpl(upstreamUrl, init)
  } catch {
    trace('upstream_fetch_error', route, startedAt)
    // POST上游传输失败时，服务端可能已经创建任务，不得提示“可以直接重试”。
    return json(502, { error: 'upstream_unreachable', submission_state: request.method === 'POST' ? 'unknown' : 'not_applicable' }, cors)
  }
  trace('upstream_headers', route, startedAt, { upstreamStatus: upstream.status })

  // 7. 回包：保留上游状态码与响应体；只带回 Content-Type + CORS 头，
  //    不透传上游其它头（Set-Cookie 等）
  const respHeaders = new Headers(cors)
  const upstreamType = upstream.headers.get('Content-Type')
  if (upstreamType) respHeaders.set('Content-Type', upstreamType)
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}

export default {
  fetch(request, env) {
    return handleRequest(request, env)
  },
}
