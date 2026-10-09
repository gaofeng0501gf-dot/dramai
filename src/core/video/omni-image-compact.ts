/**
 * Kling Omni direct Base64 transport: reduce only oversized browser-side copies.
 * Never replace the original project assets or silently downsample below 1600px
 * long edge / JPEG quality 0.84. A remaining oversized request fails before POST.
 */
export const DRAMAI_KLING_PROXY_HOST = 'dramai-kling-proxy.gaofeng0501gf.workers.dev'

/** Do not change external/custom Kling provider payloads. */
export function isDramaiOmniProxy(urlString: string): boolean {
  try {
    const url = new URL(urlString)
    return (
      url.protocol === 'https:' &&
      url.hostname === DRAMAI_KLING_PROXY_HOST &&
      !url.pathname.replace(/\/+$/, '')
    )
  } catch {
    return false
  }
}

export const OMNI_DIRECT_MAX_POST_BYTES = 5 * 1024 * 1024
const PAYLOAD_HEADROOM_BYTES = 32 * 1024
const JPEG_MATTE = '#777777'

export interface CompactStage {
  maxEdge: number
  quality: number
}

export const OMNI_COMPACT_STAGES: ReadonlyArray<CompactStage> = [
  { maxEdge: 2400, quality: 0.92 },
  { maxEdge: 2048, quality: 0.9 },
  { maxEdge: 1800, quality: 0.87 },
  { maxEdge: 1600, quality: 0.84 },
]

export interface OmniCompactInput {
  blob: Blob
  name?: string
}

export type OmniEncode = (blob: Blob, stage: CompactStage, signal?: AbortSignal) => Promise<Blob>

export function estimatedBase64Bytes(blob: Blob): number {
  return 4 * Math.ceil(blob.size / 3)
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('图片处理已取消', 'AbortError')
}

/**
 * Use Blob/ObjectURL for older browsers; createImageBitmap retains orientation
 * in modern browsers. The original object is never changed.
 */
async function decodeImage(blob: Blob): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  dispose: () => void
}> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    }
  }
  if (typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('当前浏览器不支持离线处理参考图，请使用最新版Chrome或Edge')
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

/** JPEG is intentionally used only for *derived* references, with neutral matte for transparent PNG. */
export async function encodeOmniReferenceJpeg(
  blob: Blob,
  stage: CompactStage,
  signal?: AbortSignal,
): Promise<Blob> {
  ensureNotAborted(signal)
  if (typeof document === 'undefined') {
    throw new Error('参考图压缩需要浏览器图像处理能力')
  }
  let decoded: Awaited<ReturnType<typeof decodeImage>>
  try {
    decoded = await decodeImage(blob)
  } catch {
    throw new Error('参考图无法解码，请确认图片格式有效')
  }
  try {
    ensureNotAborted(signal)
    const edge = Math.max(decoded.width, decoded.height)
    if (!edge) throw new Error('参考图尺寸无效')
    const scale = Math.min(1, stage.maxEdge / edge)
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('无法初始化浏览器图片处理')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = JPEG_MATTE
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(decoded.source, 0, 0, width, height)
    const result = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (encoded) =>
          encoded?.type === 'image/jpeg'
            ? resolve(encoded)
            : reject(new Error('浏览器JPEG编码失败')),
        'image/jpeg',
        stage.quality,
      )
    })
    canvas.width = 0
    canvas.height = 0
    ensureNotAborted(signal)
    return result
  } finally {
    decoded.dispose()
  }
}

/**
 * Adaptive size budget based on actual encoded bytes. Preserve small/original
 * files unchanged; larger references are encoded from the *original* at each
 * stage (no repeated lossy recompression), largest first.
 *
 * The total request limit is checked again against the final JSON UTF-8 bytes
 * by the caller; estimated Base64 budget reserves overhead for prompt/JSON.
 */
export async function compactOmniReferences(
  refs: ReadonlyArray<OmniCompactInput>,
  options: {
    maxPostBytes?: number
    encode?: OmniEncode
    signal?: AbortSignal
  } = {},
): Promise<OmniCompactInput[]> {
  const maxPostBytes = options.maxPostBytes ?? OMNI_DIRECT_MAX_POST_BYTES
  const maxImageBytes = maxPostBytes - PAYLOAD_HEADROOM_BYTES
  if (maxImageBytes <= 0) throw new Error('视频请求体积预算无效')
  const current = refs.map((ref) => ({ ...ref }))
  const order = current
    .map((ref, index) => ({ index, bytes: ref.blob.size }))
    .sort((a, b) => b.bytes - a.bytes)
  let total = current.reduce((sum, ref) => sum + estimatedBase64Bytes(ref.blob), 0)
  if (total <= maxImageBytes) return current
  const encode = options.encode ?? encodeOmniReferenceJpeg
  for (const stage of OMNI_COMPACT_STAGES) {
    for (const { index } of order) {
      ensureNotAborted(options.signal)
      if (total <= maxImageBytes) return current
      // Tiny originals already preserve more information than a JPEG recode.
      if (current[index].blob.size < 160 * 1024) continue
      const replacement = await encode(refs[index].blob, stage, options.signal)
      if (!replacement.size || replacement.type !== 'image/jpeg') {
        throw new Error('参考图JPEG编码结果无效，已停止提交')
      }
      const before = estimatedBase64Bytes(current[index].blob)
      const after = estimatedBase64Bytes(replacement)
      if (after < before) {
        current[index].blob = replacement
        total += after - before
      }
    }
  }
  if (total > maxImageBytes) {
    throw new Error(
      `7张参考图压缩后仍有${(total / 1048576).toFixed(1)}MiB，为保护人物细节已停止压缩和视频提交；请检查异常大图。`,
    )
  }
  return current
}
