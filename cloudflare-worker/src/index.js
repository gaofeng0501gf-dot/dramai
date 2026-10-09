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

const CORS_METHODS = 'GET,POST,DELETE,OPTIONS'
const CORS_HEADERS = 'Authorization,Content-Type'
const TASK_PATH = /^\/v1\/videos\/omni-video\/[A-Za-z0-9._-]{1,128}$/
const ASSET_COLLECTION = '/v1/omni-assets'
const ASSET_STATUS = '/v1/omni-assets/status'
const ASSET_PATH = /^\\/v1\\/omni-assets\\/([0-9a-f]{8}-[0-9a-f-]{27,28})\\.(png|jpg)$/
export const MAX_ASSET_BYTES = 10 * 1024 * 1024
export const ASSET_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 白名单：只放行 dramai Kling Omni 用到的三个接口。
 *   GET  /account/costs                    零费用账户资源查询（测试连接）
 *   POST /v1/videos/omni-video             提交 Omni 任务
 *   GET  /v1/videos/omni-video/{task_id}   轮询任务
 * 返回该路径允许的方法；不在白名单返回 null。
 */
export function allowedMethodFor(pathname) {
  if (pathname === ASSET_COLLECTION) return 'POST'
  if (pathname === ASSET_STATUS) return 'GET'
  if (ASSET_PATH.test(pathname)) return 'GET'
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

/** 所有图片存放于私有 R2，临时 URL 随机且过期后不可读。 */
function objectInfo(pathname) {
  const match = ASSET_PATH.exec(pathname)
  if (!match) return null
  return { key: `omni/${match[1]}.${match[2]}`, mime: match[2] === 'png' ? 'image/png' : 'image/jpeg' }
}

async function serveAsset(request, env, url) {
  if (!env?.OMNI_ASSETS) return json(503, { error: 'r2_not_configured' })
  const info = objectInfo(url.pathname)
  const object = info && (request.method === 'HEAD'
    ? await env.OMNI_ASSETS.head(info.key)
    : await env.OMNI_ASSETS.get(info.key))
  if (!object) return json(404, { error: 'not_found' })
  const expiresAt = Number(object.customMetadata?.expiresAt ?? 0)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    // R2 生命周期规则负责物理清理；逻辑过期即刻拒绝读取。
    return json(404, { error: 'not_found' })
  }
  const headers = new Headers({
    'Content-Type': info.mime,
    'Content-Length': String(object.size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (request.headers.get('Origin') === ALLOWED_ORIGIN) {
    Object.entries(corsHeaders(ALLOWED_ORIGIN)).forEach(([k, v]) => headers.set(k, v))
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
}

async function uploadAsset(request, env, cors) {
  if (!env?.OMNI_ASSETS) return json(503, { error: 'r2_not_configured' }, cors)
  const mime = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (mime !== 'image/jpeg' && mime !== 'image/png') {
    return json(415, { error: 'unsupported_image_type' }, cors)
  }
  const lengthHeader = request.headers.get('Content-Length')
  const length = Number(lengthHeader)
  if (!lengthHeader || !Number.isSafeInteger(length) || length <= 0) {
    return json(411, { error: 'content_length_required' }, cors)
  }
  if (length > MAX_ASSET_BYTES) return json(413, { error: 'image_too_large', maxBytes: MAX_ASSET_BYTES }, cors)
  if (!request.body) return json(400, { error: 'missing_image_body' }, cors)
  const uuid = crypto.randomUUID()
  const suffix = mime === 'image/png' ? 'png' : 'jpg'
  const key = `omni/${uuid}.${suffix}`
  const expiresAt = Date.now() + ASSET_TTL_MS
  const startedAt = Date.now()
  try {
    await env.OMNI_ASSETS.put(key, request.body, {
      httpMetadata: { contentType: mime, cacheControl: 'private, no-store' },
      customMetadata: { expiresAt: String(expiresAt) },
    })
  } catch {
    trace('asset_upload_error', 'asset_upload', startedAt)
    return json(502, { error: 'asset_upload_failed' }, cors)
  }
  trace('asset_uploaded', 'asset_upload', startedAt, { requestBytes: length })
  return json(201, {
    url: `${new URL(request.url).origin}${ASSET_COLLECTION}/${uuid}.${suffix}`,
    expiresAt,
  }, { ...cors, 'Cache-Control': 'no-store' })
}

async function deleteAsset(request, env, url, cors) {
  if (!env?.OMNI_ASSETS) return json(503, { error: 'r2_not_configured' }, cors)
  await env.OMNI_ASSETS.delete(objectInfo(url.pathname).key)
  return new Response(null, { status: 204, headers: cors })
}

/**
 * 处理一个请求。fetchImpl 可注入，便于本地单测；线上用全局 fetch。
 */
export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin')
  // Kling 下载图片时无 Origin/Authorization；只允许获取不可猜、未过期的临时对象。
  if (objectInfo(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveAsset(request, env, url)
  }

  // 1. Origin：只允许 GitHub Pages 上的 dramai；没有 Origin 的请求（curl 等）也拒绝
  if (origin !== ALLOWED_ORIGIN) {
    return json(403, { error: 'origin_not_allowed' }, { Vary: 'Origin' })
  }
  const cors = corsHeaders(origin)

  // 2. 服务端配置不完整时直接失败（不泄露具体缺哪一项）
  if (!env || !env.KLING_API_KEY || !env.PROXY_TOKEN) {
    return json(500, { error: 'proxy_not_configured' }, cors)
  }

  const allowed = allowedMethodFor(url.pathname)

  // 3. 预检
  if (request.method === 'OPTIONS') {
    if (!allowed) return json(404, { error: 'not_found' }, cors)
    return new Response(null, { status: 204, headers: cors })
  }

  // 4. 路径 + 方法白名单
  if (!allowed || (request.method !== allowed && !(objectInfo(url.pathname) && request.method === 'DELETE'))) {
    return json(404, { error: 'not_found' }, cors)
  }

  // 5. 代理口令：必须严格等于 `Bearer ${PROXY_TOKEN}`
  const auth = request.headers.get('Authorization') ?? ''
  if (!timingSafeEqual(auth, `Bearer ${env.PROXY_TOKEN}`)) {
    return json(401, { error: 'unauthorized' }, cors)
  }

  if (url.pathname === ASSET_STATUS) {
    return json(env.OMNI_ASSETS ? 200 : 503, { ready: Boolean(env.OMNI_ASSETS), maxBytes: MAX_ASSET_BYTES }, cors)
  }
  if (url.pathname === ASSET_COLLECTION) return uploadAsset(request, env, cors)
  if (objectInfo(url.pathname) && request.method === 'DELETE') return deleteAsset(request, env, url, cors)

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
