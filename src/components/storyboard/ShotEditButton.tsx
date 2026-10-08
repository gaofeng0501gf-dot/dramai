import { useState, type FormEvent } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Modal } from '@/components/ui/modal'
import { Textarea } from '@/components/ui/textarea'
import { updateStoryboard } from '@/core/storage/storyboards'
import { KLING_OMNI_PROMPT_MAX, isKlingOmni } from '@/core/video/omni'
import { useActiveProvider } from '@/store/settings'
import type { Storyboard } from '@/types/domain'

interface Props {
  shot: Storyboard
}

const OMNI_DESCRIPTION =
  'Kling Omni 会把「视频动作 / 导演指令」作为视频主体；系统再自动追加运镜、参考图、一致性、电影级物理/特效规则和声音规则。'
const OMNI_AUDIO_NOTE =
  'Omni 原生声音只认上方 sceneText 里明确写出的「角色名：『台词』」；这里的旁白不会自动变成对白。'
const OMNI_IMAGE_PROMPT_NOTE =
  'Kling Omni 视频不会使用这里的静态 imagePrompt，保留它只为切回普通图生视频模式兼容。'

export function ShotEditButton({ shot }: Props) {
  const provider = useActiveProvider('image2video')
  const omni = isKlingOmni(provider)
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
        title="编辑这一镜的动作、对白、旁白和生图提示词"
      >
        <Pencil className="h-3.5 w-3.5" />
        编辑分镜
      </Button>
      {open && <ShotEditDialog shot={shot} omni={omni} onClose={() => setOpen(false)} />}
    </>
  )
}

function ShotEditDialog({
  shot,
  omni,
  onClose,
}: {
  shot: Storyboard
  omni: boolean
  onClose: () => void
}) {
  const [sceneText, setSceneText] = useState(shot.sceneText)
  const [narration, setNarration] = useState(shot.narration ?? '')
  const [imagePrompt, setImagePrompt] = useState(shot.imagePrompt ?? '')
  const [saving, setSaving] = useState(false)

  const scene = sceneText.trim()
  const description = omni ? OMNI_DESCRIPTION : '修改这一镜的场景动作、旁白与生图提示词。'
  const promptLimitNote = omni
    ? `Omni 最终 prompt 上限 ${KLING_OMNI_PROMPT_MAX} 字符，过长时系统保留首尾并压缩中段。`
    : undefined

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!scene) return
    setSaving(true)
    try {
      await updateStoryboard(shot.id, {
        sceneText: scene,
        narration: narration.trim() || undefined,
        imagePrompt: imagePrompt.trim() || undefined,
        ...(shot.status === 'failed' ? { status: 'pending' as const } : {}),
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      className="max-w-3xl"
      title={`编辑分镜 #${String(shot.sequence).padStart(2, '0')}`}
      description={description}
    >
      <form onSubmit={save} className="flex flex-col gap-5">
        <Label>
          {omni ? '视频动作 / 导演指令（Omni 实际发送主体）' : '场景 / 动作'}
          <Textarea
            rows={14}
            value={sceneText}
            onChange={(e) => setSceneText(e.target.value)}
            required
            className="mt-1 font-mono text-xs leading-relaxed"
          />
          <span className="mt-1 block text-[11px] font-normal text-muted">
            当前 {sceneText.length} 字符{promptLimitNote ? `；${promptLimitNote}` : ''}
          </span>
        </Label>

        <Label>
          旁白（可选）
          <Textarea
            rows={2}
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            className="mt-1"
          />
        </Label>
        {omni && <p className="text-[11px] text-muted">{OMNI_AUDIO_NOTE}</p>}
        <Label>
          生图提示词（可选）
          <Textarea
            rows={4}
            value={imagePrompt}
            onChange={(e) => setImagePrompt(e.target.value)}
            className="mt-1 font-mono text-xs"
          />
        </Label>
        {omni && <p className="text-[11px] text-muted">{OMNI_IMAGE_PROMPT_NOTE}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!scene || saving}>
            {saving ? '保存中…' : '保存分镜'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
