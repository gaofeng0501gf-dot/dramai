import { db } from '@/core/storage/db'
import { createAsset, deleteAsset } from '@/core/storage/assets'
import { updateStoryboard } from '@/core/storage/storyboards'
import { createVideoClient } from '@/core/video/factory'
import { KlingOmniSubmissionUnknownError } from '@/core/video/kling-omni-client'
import { buildOmniPrompt, isKlingOmni, resolveOmniReferenceBlobs } from '@/core/video/omni'
import type { I2VRequest } from '@/core/video/types'
import type { CameraMovement, CameraSpeed, Provider, Storyboard } from '@/types/domain'

export interface VideoShotEvent {
  shotId: string
  phase: 'submitting' | 'queued' | 'processing' | 'downloading' | 'persisting' | 'done' | 'error'
  message?: string
  progress?: number
  /** POST是否可能已创建付费任务。仅此类错误需要人工确认再重试。 */
  submissionUncertain?: boolean
}

interface RunOpts {
  provider: Provider
  storyboard: Storyboard
  /** 不传时取 storyboard.cameraParams，再不行就 'static'。 */
  cameraOverride?: { movement: CameraMovement; speed?: CameraSpeed }
  /** 默认 4 秒；Kling/Vidu 通常 5/10。 */
  durationSec?: number
  aspectRatio?: string
  /** 轮询间隔毫秒。默认 6000。 */
  pollIntervalMs?: number
  /** 总超时秒数。默认 600（10 分钟）。 */
  timeoutSec?: number
  signal?: AbortSignal
}

const CAMERA_PHRASES: Record<CameraMovement, string> = {
  static: 'static camera, locked-off framing',
  pan_left: 'slow camera pan to the left',
  pan_right: 'slow camera pan to the right',
  tilt_up: 'camera tilts upward',
  tilt_down: 'camera tilts downward',
  zoom_in: 'gentle zoom in',
  zoom_out: 'gentle zoom out',
  orbit_left: 'orbiting camera moves to the left around subject',
  orbit_right: 'orbiting camera moves to the right around subject',
  dolly_in: 'dolly push forward',
  dolly_out: 'dolly pull back',
}

function buildCameraInstruction(cam?: { movement: CameraMovement; speed?: CameraSpeed }): string {
  if (!cam || cam.movement === 'static') return 'static camera, no movement'
  const speedAdj = cam.speed === 'slow' ? 'very slowly, ' : cam.speed === 'fast' ? 'quickly, ' : ''
  return `${speedAdj}${CAMERA_PHRASES[cam.movement]}`
}

/**
 * 给单个分镜生成视频片段。
 * 流程：submit → poll → download blob → 落库 asset → 写回 videoAssetId.
 */
export async function* generateShotVideo(
  opts: RunOpts,
): AsyncGenerator<VideoShotEvent, void, void> {
  const shot = opts.storyboard
  const omni = isKlingOmni(opts.provider)
  const camera = opts.cameraOverride ?? shot.cameraParams ?? { movement: 'static' as const }
  const cameraInstruction = buildCameraInstruction(camera)
  const baseReq = {
    model: opts.provider.model,
    durationSec: opts.durationSec ?? shot.durationSec ?? 5,
    aspectRatio: opts.aspectRatio,
    signal: opts.signal,
  }

  let req: I2VRequest
  if (omni) {
    // Kling Omni：不需要起始图，直接用分镜选中的参考素材（≤7，复用 IndexedDB 现有 Blob）
    const resolved = await resolveOmniReferenceBlobs(
      shot.referenceAssetIds,
      (id) => db.assets.get(id),
      await buildReferenceNamer(shot.projectId),
    )
    if (!resolved.ok) {
      yield { shotId: shot.id, phase: 'error', message: resolved.error }
      return
    }
    req = {
      ...baseReq,
      // 以 sceneText 的完整动作过程为主体；不用静态关键帧 imagePrompt
      prompt: buildOmniPrompt({
        sceneText: shot.sceneText,
        cameraInstruction,
        referenceNames: resolved.refs.map((r) => r.name),
      }),
      referenceImageBlobs: resolved.refs,
    }
  } else {
    // 普通 image2video：原逻辑不变
    if (!shot.imageAssetId) {
      yield { shotId: shot.id, phase: 'error', message: '该分镜还没有起始图（先生图再生视频）' }
      return
    }
    const imageAsset = await db.assets.get(shot.imageAssetId)
    if (!imageAsset) {
      yield { shotId: shot.id, phase: 'error', message: '起始图缺失（asset 已被清理）' }
      return
    }
    req = {
      ...baseReq,
      prompt: [shot.imagePrompt, shot.sceneText].filter(Boolean).join('. '),
      imageBlob: imageAsset.blob,
      cameraInstruction,
    }
  }

  yield { shotId: shot.id, phase: 'submitting' }

  const client = createVideoClient(opts.provider)

  let handle
  try {
    handle = await client.submit(req)
  } catch (err) {
    yield {
      shotId: shot.id,
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
      submissionUncertain: err instanceof KlingOmniSubmissionUnknownError,
    }
    await updateStoryboard(shot.id, { status: 'failed' })
    return
  }

  // 把 task handle 持久化，方便刷新页面恢复
  await updateStoryboard(shot.id, {
    pendingVideoTask: {
      taskId: handle.taskId,
      apiFlavor: handle.apiFlavor,
      submittedAt: Date.now(),
    },
  })

  const interval = opts.pollIntervalMs ?? 6000
  const deadline = Date.now() + (opts.timeoutSec ?? 600) * 1000

  let videoUrl: string | undefined
  let resultDuration: number | undefined
  yield { shotId: shot.id, phase: 'queued' }

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      // 已取得task_id，浏览器中止轮询不等于云端取消；保留任务句柄防止重复付费。
      yield {
        shotId: shot.id,
        phase: 'error',
        message: '已停止本地轮询；可灵任务可能仍在运行，请用已保存的任务ID核查。',
      }
      return
    }
    await sleep(interval, opts.signal)
    const status = await client.poll(handle, opts.signal)
    if (status.kind === 'queued') {
      yield { shotId: shot.id, phase: 'queued' }
      continue
    }
    if (status.kind === 'processing') {
      yield {
        shotId: shot.id,
        phase: 'processing',
        progress: status.progress,
        message: status.message,
      }
      continue
    }
    if (status.kind === 'failed') {
      yield { shotId: shot.id, phase: 'error', message: status.message }
      await updateStoryboard(shot.id, {
        status: 'failed',
        pendingVideoTask: undefined,
      })
      return
    }
    if (status.kind === 'succeeded') {
      videoUrl = status.videoUrl
      resultDuration = status.durationSec
      break
    }
  }

  if (!videoUrl) {
    yield { shotId: shot.id, phase: 'error', message: '轮询超时' }
    await updateStoryboard(shot.id, { pendingVideoTask: undefined })
    return
  }

  yield { shotId: shot.id, phase: 'downloading' }

  let videoBlob: Blob
  try {
    const r = await fetch(videoUrl, { signal: opts.signal })
    if (!r.ok) throw new Error(`下载视频 HTTP ${r.status}`)
    videoBlob = await r.blob()
  } catch (err) {
    yield {
      shotId: shot.id,
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
    await updateStoryboard(shot.id, { pendingVideoTask: undefined })
    return
  }

  yield { shotId: shot.id, phase: 'persisting' }

  if (shot.videoAssetId) {
    try {
      await deleteAsset(shot.videoAssetId)
    } catch {
      /* noop */
    }
  }

  const asset = await createAsset({
    projectId: shot.projectId,
    kind: 'video',
    blob: videoBlob,
    mimeType: videoBlob.type || 'video/mp4',
  })

  await updateStoryboard(shot.id, {
    videoAssetId: asset.id,
    status: 'video-ready',
    durationSec: resultDuration ?? shot.durationSec,
    pendingVideoTask: undefined,
  })

  yield { shotId: shot.id, phase: 'done' }
}

/** assetId → 角色名 / 素材名，用于 Omni prompt 里的 <<<image_N>>> 说明。 */
async function buildReferenceNamer(projectId: string): Promise<(id: string) => string | undefined> {
  const [characters, materials] = await Promise.all([
    db.characters.where('projectId').equals(projectId).toArray(),
    db.materials.where('projectId').equals(projectId).toArray(),
  ])
  const names = new Map<string, string>()
  for (const m of materials) if (m.assetId) names.set(m.assetId, m.name)
  for (const c of characters)
    if (c.referenceAssetId) names.set(c.referenceAssetId, `角色·${c.name}`)
  return (id) => names.get(id)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
