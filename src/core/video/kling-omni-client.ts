import type { Provider } from '@/types/domain'
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
export function createKlingOmniClient(
  provider: Pick<Provider, 'baseUrl' | 'apiKey' | 'model'>,
): I2VClient {
  const root = provider.baseUrl.replace(/\/+$/, '')

  return {
    async submit(req: I2VRequest): Promise<I2VTaskHandle> {
      const refs = req.referenceImageBlobs ?? []
      if (refs.length === 0) throw new Error(OMNI_ERR_NO_REFS)
      if (refs.length > KLING_OMNI_MAX_REFS) throw new Error(omniErrTooMany(refs.length))

      const image_list = await Promise.all(
        refs.map(async (r) => ({ image_url: await blobToPlainBase64(r.blob) })),
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

      const res = await fetch(`${root}${KLING_OMNI_SUBMIT_PATH}`, {
        method: 'POST',
        headers: await jsonHeaders(provider.apiKey),
        body: JSON.stringify(body),
        signal: req.signal,
      })
      if (!res.ok) {
        throw new Error(
          `Kling Omni submit HTTP ${res.status}: ${(await safeText(res)).slice(0, 280)}`,
        )
      }
      const json = (await res.json()) as {
        code?: number
        message?: string
        data?: { task_id?: string }
        task_id?: string
      }
      if (typeof json.code === 'number' && json.code !== 0) {
        throw new Error(`Kling Omni submit code ${json.code}: ${json.message ?? ''}`.trim())
      }
      const taskId = json.data?.task_id ?? json.task_id
      if (!taskId) throw new Error('Kling Omni submit 响应里没找到 task_id')
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
