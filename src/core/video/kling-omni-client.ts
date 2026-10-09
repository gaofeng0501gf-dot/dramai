import type { Provider } from '@/types/domain'
import {
  compactOmniReferences,
  isDramaiOmniProxy,
  OMNI_DIRECT_MAX_POST_BYTES,
} from '@/core/video/omni-image-compact'
import type { I2VClient, I2VRequest, I2VStatus, I2VTaskHandle } from '@/core/video/types'
import {
  KLING_OMNI_MAX_REFS,
  KLING_OMNI_MODEL,
  KLING_OMNI_SUBMIT_PATH,
  OMNI_ERR_NO_REFS,
  omniErrTooMany,
  toOmniDuration,
} from '@/core/video/omni'

/**
 * Kling 3.0 Omni 原生多参考视频客户端。
 *
 * 官方协议（Kling 视频 Omni）：
 *   POST {baseUrl}/v1/videos/omni-video
 *     body: {
 *       model_name: "kling-v3-omni",
 *       prompt,                      // ≤2500 字，用 <<<image_N>>> 引用 image_list 第 N 张
 *       image_list: [{ image_url }], // URL 或纯 Base64（不带 data: 前缀）；不传 type = 普通参考图
 *       mode: "std"|"pro"|"4k",
 *       aspect_ratio: "16:9"|"9:16"|"1:1",  // 没有首帧时必填
 *       duration: "3"~"15",
 *       sound: "on"|"off"
 *     }
 *     resp: { code, message, data: { task_id, task_status } }
 *   GET  {baseUrl}/v1/videos/omni-video/{task_id}
 *     resp: { code, data: { task_status, task_status_msg?,
 *                            task_result?: { videos: [{ url, duration }] } } }
 *
 * 与旧 image2video 的区别：没有 image（起始帧）字段，参考图走 image_list；
 * 不复用 kling-client 的请求体。
 *
 * 鉴权（Kling Open Platform 新版）：
 *   - 默认：Provider.apiKey 原样作为 Bearer Token → `Authorization: Bearer <API_KEY>`。
 *     任何内容（包括带冒号的）都不会被解析成 AK/SK。
 *   - legacy 兼容（显式开启）：apiKey 以 `legacy-jwt:` 开头，写成
 *     `legacy-jwt:<AccessKey>:<SecretKey>`，才会在浏览器内用 HS256 签发 30 分钟 JWT。
 */
/** 提交链路断开或5xx时，上游可能已经创建付费任务；禁止自动重试。 */
export class KlingOmniSubmissionUnknownError extends Error {
  constructor() {
    super(
      'Kling Omni 提交状态未知：连接中断或上游异常，可能已创建付费任务。请先在可灵生成记录与账单核查，勿直接重复提交。',
    )
    this.name = 'KlingOmniSubmissionUnknownError'
  }
}

export function createKlingOmniClient(
  provider: Pick<Provider, 'baseUrl' | 'apiKey' | 'model'>,
): I2VClient {
  const root = provider.baseUrl.replace(/\/+$/, '')

  return {
    async submit(req: I2VRequest): Promise<I2VTaskHandle> {
      const refs = req.referenceImageBlobs ?? []
      if (refs.length === 0) throw new Error(OMNI_ERR_NO_REFS)
      if (refs.length > KLING_OMNI_MAX_REFS) throw new Error(omniErrTooMany(refs.length))

      // 现有 dramai Worker 直接接收 Base64；不需要 R2/KV 或额外付款账户。
      // 仅当总请求过大时，本地生成高品质传输副本，绝不修改 IndexedDB 原图。
      const compact = isDramaiOmniProxy(root)
      const sendRefs = compact ? await compactOmniReferences(refs, { signal: req.signal }) : refs
      const image_list = await Promise.all(
        sendRefs.map(async (r) => ({ image_url: await blobToPlainBase64(r.blob) })),
      )
      const body = {
        model_name: req.model || provider.model || KLING_OMNI_MODEL,
        prompt: req.prompt,
        image_list,
        mode: 'pro',
        aspect_ratio: req.aspectRatio || '16:9',
        duration: toOmniDuration(req.durationSec),
        sound: 'on',
      }

      // 测量UTF-8实际发送字节数（而不是JS字符长度），不超限才允许付费提交。
      const requestJson = JSON.stringify(body)
      if (compact && new TextEncoder().encode(requestJson).byteLength > OMNI_DIRECT_MAX_POST_BYTES) {
        throw new Error('参考图请求仍超过5MiB安全传输上限，已阻止视频提交，请检查图片素材')
      }

      let res: Response
      try {
        res = await fetch(`${root}${KLING_OMNI_SUBMIT_PATH}`, {
          method: 'POST',
          headers: await jsonHeaders(provider.apiKey),
          body: requestJson,
          signal: req.signal,
        })
      } catch {
        // Fetch / CORS / AbortError 无响应：无法判断上游是否创建任务。
        throw new KlingOmniSubmissionUnknownError()
      }
      if (!res.ok) {
        // Worker和上游5xx不意味着绝对未创建付费任务。
        if (res.status >= 500) throw new KlingOmniSubmissionUnknownError()
        throw new Error(
          `Kling Omni submit HTTP ${res.status}: ${(await safeText(res)).slice(0, 280)}`,
        )
      }
      let json: {
        code?: number
        message?: string
        data?: { task_id?: string }
        task_id?: string
      }
      try {
        json = (await res.json()) as typeof json
      } catch {
        // HTTP已成功，但响应损坏或连接中断，不能安全重新提交。
        throw new KlingOmniSubmissionUnknownError()
      }
      if (typeof json.code === 'number' && json.code !== 0) {
        throw new Error(`Kling Omni submit code ${json.code}: ${json.message ?? ''}`.trim())
      }
      const taskId = json.data?.task_id ?? json.task_id
      if (!taskId) throw new KlingOmniSubmissionUnknownError()
      return { taskId, apiFlavor: 'kling-omni' }
    },

    async poll(handle: I2VTaskHandle, signal?: AbortSignal): Promise<I2VStatus> {
      const res = await fetch(
        `${root}${KLING_OMNI_SUBMIT_PATH}/${encodeURIComponent(handle.taskId)}`,
        { headers: await jsonHeaders(provider.apiKey), signal },
      )
      if (!res.ok) {
        return {
          kind: 'failed',
          message: `Kling Omni poll HTTP ${res.status}: ${(await safeText(res)).slice(0, 200)}`,
        }
      }
      const json = (await res.json()) as {
        code?: number
        message?: string
        data?: {
          task_status?: string
          task_status_msg?: string
          task_result?: { videos?: Array<{ url?: string; duration?: number | string }> }
        }
      }
      // HTTP 200 不等于业务成功：code≠0 直接失败，不能当 queued 一直轮询到超时
      if (typeof json.code === 'number' && json.code !== 0) {
        return {
          kind: 'failed',
          message: `Kling Omni poll code ${json.code}: ${json.message ?? ''}`,
        }
      }
      const status = json.data?.task_status?.toLowerCase() ?? 'unknown'
      if (status === 'succeed' || status === 'succeeded' || status === 'success') {
        const v = json.data?.task_result?.videos?.[0]
        if (!v?.url) return { kind: 'failed', message: 'Kling Omni: 任务成功但缺少 video.url' }
        const dur = v.duration === undefined ? undefined : Number(v.duration)
        return {
          kind: 'succeeded',
          videoUrl: v.url,
          durationSec: Number.isFinite(dur) ? dur : undefined,
        }
      }
      if (status === 'failed' || status === 'fail' || status === 'error') {
        return { kind: 'failed', message: json.data?.task_status_msg ?? 'Kling Omni 任务失败' }
      }
      if (status === 'processing' || status === 'running') {
        return { kind: 'processing', message: json.data?.task_status_msg }
      }
      return { kind: 'queued' }
    },
  }
}

async function jsonHeaders(apiKey?: string): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  const auth = await resolveKlingAuthorization(apiKey)
  if (auth) h.Authorization = auth
  return h
}

/** 显式 legacy 模式前缀：`legacy-jwt:<AccessKey>:<SecretKey>`。 */
export const KLING_LEGACY_JWT_PREFIX = 'legacy-jwt:'

/**
 * 生成 Authorization 头。
 *   默认：`Bearer <API_KEY>`，apiKey 原样使用，绝不进入 JWT 签发。
 *   仅当 apiKey 以 `legacy-jwt:` 开头时走 legacy AK/SK JWT。
 * signLegacy 可注入，便于测试断言普通 Key 不会触发签发。
 */
export async function resolveKlingAuthorization(
  apiKey: string | undefined,
  signLegacy: (ak: string, sk: string) => Promise<string> = signKlingLegacyJwt,
): Promise<string | undefined> {
  const key = apiKey?.trim()
  if (!key) return undefined
  if (!key.startsWith(KLING_LEGACY_JWT_PREFIX)) return `Bearer ${key}`

  const m = /^([^\s:]+):([^\s:]+)$/.exec(key.slice(KLING_LEGACY_JWT_PREFIX.length))
  if (!m) {
    throw new Error('Kling legacy JWT 格式应为 legacy-jwt:<AccessKey>:<SecretKey>')
  }
  return `Bearer ${await signLegacy(m[1], m[2])}`
}

/** legacy：AK/SK → HS256 JWT（30 分钟有效）。仅在显式 legacy-jwt: 模式下调用。 */
export async function signKlingLegacyJwt(
  ak: string,
  sk: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const enc = (obj: object) => base64Url(new TextEncoder().encode(JSON.stringify(obj)))
  const unsigned = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    iss: ak,
    exp: nowSec + 1800,
    nbf: nowSec - 5,
  })}`
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sk),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(unsigned))
  return `${unsigned}.${base64Url(new Uint8Array(sig))}`
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** IndexedDB Blob → 纯 Base64（官方要求不带 data:...;base64, 前缀）。 */
export async function blobToPlainBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
