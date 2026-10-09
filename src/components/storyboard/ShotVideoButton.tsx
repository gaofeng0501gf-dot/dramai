import { useRef, useState } from 'react'
import { Film, Loader2, StopCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useActiveProvider } from '@/store/settings'
import { generateShotVideo, type VideoShotEvent } from '@/core/pipeline/video-shot'
import { isKlingOmni, isShotVideoReady } from '@/core/video/omni'
import type { Storyboard } from '@/types/domain'

interface Props {
  shot: Storyboard
  className?: string
}

// 仅在 localStorage 记录分镜提交时间，绝不保存密钥、提示词或参考图。
const submitGuardKey = (shotId: string) => `dramai:omni-submit-pending:${shotId}`

function hasSubmitGuard(key: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

function putSubmitGuard(key: string): void {
  window.localStorage.setItem(key, String(Date.now()))
}

function clearSubmitGuard(key: string): void {
  window.localStorage.removeItem(key)
}

function resolvesSubmitUncertainty(event: VideoShotEvent): boolean {
  if (event.phase === 'error') return !event.submissionUncertain
  return (
    event.phase === 'queued' ||
    event.phase === 'processing' ||
    event.phase === 'downloading' ||
    event.phase === 'persisting' ||
    event.phase === 'done'
  )
}

const PHASE_LABEL: Record<VideoShotEvent['phase'], string> = {
  submitting: '提交中…',
  queued: '排队…',
  processing: '生成中…',
  downloading: '下载中…',
  persisting: '保存中…',
  done: '完成',
  error: '失败',
}

export function ShotVideoButton({ shot, className }: Props) {
  const provider = useActiveProvider('image2video')
  const [running, setRunning] = useState(false)
  const [event, setEvent] = useState<VideoShotEvent | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inFlightRef = useRef(false)
  const guardKey = submitGuardKey(shot.id)
  const [needsVerification, setNeedsVerification] = useState(() => hasSubmitGuard(guardKey))

  if (!provider) {
    return (
      <Button variant="ghost" size="sm" disabled className={className}>
        <Film className="h-3.5 w-3.5" /> 未配视频
      </Button>
    )
  }

  if (!isShotVideoReady(shot, provider)) {
    // kling-omni 不需要起始图，只需要选好 Omni 参考素材；其它协议保持原行为
    return isKlingOmni(provider) ? (
      <Button
        variant="ghost"
        size="sm"
        disabled
        className={className}
        title="请先选择 Omni 参考素材"
      >
        <Film className="h-3.5 w-3.5" /> 需选参考
      </Button>
    ) : (
      <Button variant="ghost" size="sm" disabled className={className} title="先生图再生视频">
        <Film className="h-3.5 w-3.5" /> 需先生图
      </Button>
    )
  }

  const omni = isKlingOmni(provider)

  const stop = () => {
    // 中止可能发生在已提交之后；不清除防重复提交锁。
    abortRef.current?.abort()
  }

  const unlock = () => {
    const confirmed = window.confirm(
      '请先在可灵生成记录和账单核对该分镜是否已创建任务。确认核实后才解除重复提交保护。是否已经核实？',
    )
    if (!confirmed) return
    clearSubmitGuard(guardKey)
    setNeedsVerification(false)
    setEvent(null)
  }

  const start = async () => {
    // 双击、页面刷新、网络超时都不能静默产生第二个付费 POST。
    if (inFlightRef.current || (omni && hasSubmitGuard(guardKey))) {
      setNeedsVerification(true)
      return
    }
    inFlightRef.current = true
    abortRef.current = new AbortController()
    setRunning(true)
    setEvent(null)
    try {
      if (omni) putSubmitGuard(guardKey)
      for await (const ev of generateShotVideo({
        provider,
        storyboard: shot,
        signal: abortRef.current.signal,
      })) {
        setEvent(ev)
        if (omni && resolvesSubmitUncertainty(ev)) clearSubmitGuard(guardKey)
      }
    } catch (err) {
      setEvent({
        shotId: shot.id,
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
      // 无法分类的提交异常，保留锁以防不确定任务重复收费。
    } finally {
      if (omni) setNeedsVerification(hasSubmitGuard(guardKey))
      setRunning(false)
      inFlightRef.current = false
      abortRef.current = null
    }
  }

  return (
    <div className={className}>
      {omni && needsVerification && !running && (
        <div className="mb-2 rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          <p>
            上次提交结果未知：可灵可能已创建付费任务。请先核查可灵生成记录和账单，禁止直接重复提交。
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={unlock} className="mt-1">
            已核查，解除重新提交保护
          </Button>
        </div>
      )}
      {omni && !running && !needsVerification && shot.pendingVideoTask && (
        <p className="mb-1 text-xs text-muted">
          已有可灵任务ID：{shot.pendingVideoTask.taskId}；先核实任务状态，避免重复生成。
        </p>
      )}
      {running ? (
        <div className="flex items-center gap-2">
          <Button variant="destructive" size="sm" onClick={stop} className="gap-1.5">
            <StopCircle className="h-3.5 w-3.5" /> 中止
          </Button>
          {event && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              {PHASE_LABEL[event.phase]}
            </span>
          )}
        </div>
      ) : (
        <Button
          variant={shot.videoAssetId ? 'ghost' : 'secondary'}
          size="sm"
          onClick={start}
          disabled={omni && (needsVerification || Boolean(shot.pendingVideoTask))}
          className="gap-1.5"
        >
          <Film className="h-3.5 w-3.5" />
          {shot.videoAssetId ? '重生视频' : '生视频'}
        </Button>
      )}
      {event?.phase === 'error' && event.message && (
        <p className="mt-1 text-xs text-destructive">{event.message}</p>
      )}
    </div>
  )
}
