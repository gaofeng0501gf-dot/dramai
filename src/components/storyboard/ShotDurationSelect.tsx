import { Select } from '@/components/ui/select'
import { updateStoryboard } from '@/core/storage/storyboards'
import { KLING_OMNI_MAX_DURATION, KLING_OMNI_MIN_DURATION } from '@/core/video/omni'
import type { Storyboard } from '@/types/domain'

interface Props {
  shot: Storyboard
}

const DEFAULT_DURATION = 5

export function ShotDurationSelect({ shot }: Props) {
  const current = Math.min(
    KLING_OMNI_MAX_DURATION,
    Math.max(KLING_OMNI_MIN_DURATION, Math.round(shot.durationSec ?? DEFAULT_DURATION)),
  )

  const onDuration = (value: string) => {
    const durationSec = Number(value)
    if (
      !Number.isInteger(durationSec) ||
      durationSec < KLING_OMNI_MIN_DURATION ||
      durationSec > KLING_OMNI_MAX_DURATION
    ) {
      return
    }
    void updateStoryboard(shot.id, { durationSec })
  }

  return (
    <Select
      value={String(current)}
      onChange={(e) => onDuration(e.target.value)}
      className="h-7 w-24 px-2 text-xs"
      title="视频时长"
      aria-label="视频时长"
    >
      {Array.from(
        { length: KLING_OMNI_MAX_DURATION - KLING_OMNI_MIN_DURATION + 1 },
        (_, i) => KLING_OMNI_MIN_DURATION + i,
      ).map((sec) => (
        <option key={sec} value={sec}>
          时长 {sec}s
        </option>
      ))}
    </Select>
  )
}
