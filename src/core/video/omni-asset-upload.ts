import type { Provider } from '@/types/domain'

/** Only the explicitly configured dramai Worker uses temporary R2 URLs.
 * Other Kling providers retain their original Base64 protocol. Never silently
 * downgrade to Base64 when R2 fails, or we might retry the original ~23MB POST.
 */
export const KLING_R2_WORKER_HOST = 'dramai-kling-proxy.gaofeng0501gf.workers.dev'
const PATH = '/v1/omni-assets'
export const KLING_MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function usesOmniR2Transport(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return (
      url.protocol === 'https:' &&
      url.hostname === KLING_R2_WORKER_HOST &&
      !url.pathname.replace(/\/+$/, '')
    )
  } catch {
    return false
  }
}

function authorizedHeaders(apiKey: string, mime?: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey.trim()}` }
  if (mime) headers['Content-Type'] = mime
  return headers
}

async function explainHttp(res: Response): Promise<string> {
  try {
    const result = (await res.json()) as { error?: string }
    if (result.error === 'r2_not_configured')
      return 'Cloudflare Worker 尚未绑定 R2 存储桶 OMNI_ASSETS'
    if (result.error) return result.error
  } catch {
    // Response may be empty / HTML. Never log source images or API keys.
  }
  return `HTTP ${res.status}`
}

export async function checkOmniAssetTransport(
  provider: Pick<Provider, 'baseUrl' | 'apiKey'>,
  signal?: AbortSignal,
): Promise<void> {
  const root = provider.baseUrl.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${root}${PATH}/status`, {
      method: 'GET',
      headers: authorizedHeaders(provider.apiKey),
      signal,
    })
  } catch {
    throw new Error('临时图片URL检查失败：无法连接 R2 Worker（不会提交视频任务）')
  }
  if (!response.ok) throw new Error(`临时图片URL未就绪：${await explainHttp(response)}`)
  const json = (await response.json()) as { ready?: boolean }
  if (json.ready !== true) throw new Error('临时图片URL未就绪：R2绑定检查失败')
}

export async function uploadOmniImage(
  provider: Pick<Provider, 'baseUrl' | 'apiKey'>,
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const mime = blob.type.toLowerCase()
  if (mime !== 'image/jpeg' && mime !== 'image/png') {
    throw new Error('Kling Omni R2仅支持PNG/JPEG，请上传这两种格式的原图')
  }
  if (!blob.size || blob.size > KLING_MAX_IMAGE_BYTES) {
    throw new Error(`单张参考图必须大于0且不超过10MiB，当前${(blob.size / 1048576).toFixed(2)}MiB`)
  }
  const root = provider.baseUrl.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${root}${PATH}`, {
      method: 'POST',
      headers: authorizedHeaders(provider.apiKey, mime),
      body: blob,
      signal,
    })
  } catch {
    throw new Error('上传临时图片失败：浏览器与R2代理连接中断，尚未提交可灵视频任务')
  }
  if (!response.ok)
    throw new Error(`上传临时图片失败：${await explainHttp(response)}；尚未提交可灵视频任务`)
  let url: string | undefined
  try {
    const data = (await response.json()) as { url?: string }
    url = data.url
  } catch {
    throw new Error('上传临时图片失败：响应内容无效，尚未提交可灵视频任务')
  }
  // Only accept our own Worker / short-lived opaque URL; prevent spoofed URLs.
  const parsed = url ? new URL(url) : null
  if (
    !parsed ||
    parsed.origin !== new URL(root).origin ||
    !/^\/v1\/omni-assets\/[0-9a-f-]+\.(png|jpg)$/.test(parsed.pathname)
  ) {
    throw new Error('R2返回的图片地址无效，已中止可灵视频提交')
  }
  return parsed.href
}

export async function uploadOmniReferences(
  provider: Pick<Provider, 'baseUrl' | 'apiKey'>,
  references: ReadonlyArray<{ blob: Blob }>,
  signal?: AbortSignal,
): Promise<Array<{ image_url: string }>> {
  await checkOmniAssetTransport(provider, signal)
  const result: Array<{ image_url: string }> = []
  for (const image of references) {
    const url = await uploadOmniImage(provider, image.blob, signal)
    result.push({ image_url: url })
  }
  return result
}

/** Upload/GET/delete a tiny synthetic PNG, without calling any Kling video endpoint. */
export async function testOmniR2RoundTrip(
  provider: Pick<Provider, 'baseUrl' | 'apiKey'>,
): Promise<void> {
  await checkOmniAssetTransport(provider)
  // Valid 1x1 PNG for transport test only; never passed to Kling.
  const tinyBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
  const raw = atob(tinyBase64)
  const data = Uint8Array.from(raw, (c) => c.charCodeAt(0))
  const blob = new Blob([data], { type: 'image/png' })
  const imageUrl = await uploadOmniImage(provider, blob)
  try {
    const downloaded = await fetch(imageUrl, { cache: 'no-store' })
    if (!downloaded.ok || (await downloaded.arrayBuffer()).byteLength !== blob.size) {
      throw new Error('R2临时图片下载校验未通过')
    }
  } finally {
    try {
      await fetch(imageUrl, {
        method: 'DELETE',
        headers: authorizedHeaders(provider.apiKey),
      })
    } catch {
      // R2 lifecycle policy still cleans the temporary test object.
    }
  }
}
