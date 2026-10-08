import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Check, Images } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { useActiveProvider } from '@/store/settings'
import { db } from '@/core/storage/db'
import { getObjectURL, releaseObjectURL } from '@/core/storage/assets'
import { updateStoryboard } from '@/core/storage/storyboards'
import {
  KLING_OMNI_MAX_REFS,
  buildOmniCandidates,
  dedupeAssetIds,
  isKlingOmni,
  omniReferenceMixAdvice,
  validateOmniReferenceIds,
} from '@/core/video/omni'
import type { Asset, Character, Material, Storyboard } from '@/types/domain'

interface Props {
  shot: Storyboard
  className?: string
}

/**
 * 「Omni参考」：为单个分镜挑选 Kling Omni 参考素材（≤7）。
 * 只在当前激活的图生视频 provider 是 kling-omni 时出现。
 * 只保存 assetId 引用，不复制 Blob。
 */
export function OmniReferencePicker({ shot, className }: Props) {
  const provider = useActiveProvider('image2video')
  const [open, setOpen] = useState(false)

  if (!isKlingOmni(provider)) return null

  const count = dedupeAssetIds(shot.referenceAssetIds ?? []).length
  return (
    <>
      <Button
        variant={count > 0 ? 'ghost' : 'secondary'}
        size="sm"
        className={['gap-1.5', className].filter(Boolean).join(' ')}
        onClick={() => setOpen(true)}
        title="为该分镜选择 Kling Omni 参考图（人物 / 武器 / 场景 / 道具，最多 7 个）"
      >
        <Images className="h-3.5 w-3.5" />
        Omni参考{count > 0 ? `（${count}）` : ''}
      </Button>
      {open && <PickerDialog shot={shot} onClose={() => setOpen(false)} />}
    </>
  )
}

function PickerDialog({ shot, onClose }: { shot: Storyboard; onClose: () => void }) {
  const characters = useLiveQuery<Character[], Character[]>(
    () => db.characters.where('projectId').equals(shot.projectId).toArray(),
    [shot.projectId],
    [],
  )
  const materials = useLiveQuery<Material[], Material[]>(
    () => db.materials.where('projectId').equals(shot.projectId).toArray(),
    [shot.projectId],
    [],
  )
  const candidates = useMemo(
    () => buildOmniCandidates(shot, characters, materials),
    [shot, characters, materials],
  )
  const candidateIds = useMemo(() => candidates.map((c) => c.assetId), [candidates])
  const assets = useLiveQuery<Asset[], Asset[]>(
    () => (candidateIds.length === 0 ? [] : db.assets.where('id').anyOf(candidateIds).toArray()),
    [candidateIds.join(',')],
    [],
  )
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
  useEffect(() => {
    const ids = assets.map((a) => a.id)
    return () => {
      for (const id of ids) releaseObjectURL(id)
    }
  }, [assets])

  const [selected, setSelected] = useState<string[]>(() =>
    dedupeAssetIds(shot.referenceAssetIds ?? []),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const toggle = (id: string) => {
    setError(null)
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // 已失效（素材被删）的旧选择不参与保存
  const effective = selected.filter((id) => candidateIds.includes(id))
  const over = effective.length > KLING_OMNI_MAX_REFS
  const selectedCandidates = candidates.filter((c) => effective.includes(c.assetId))
  const mixAdvice = omniReferenceMixAdvice(selectedCandidates)

  const save = async () => {
    const ids = dedupeAssetIds(effective)
    if (ids.length > 0) {
      const v = validateOmniReferenceIds(ids)
      if (!v.ok) {
        setError(v.error)
        return
      }
    }
    setSaving(true)
    try {
      await updateStoryboard(shot.id, { referenceAssetIds: ids.length > 0 ? ids : undefined })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      className="max-w-2xl"
      title={`Omni 参考素材 · 分镜 #${String(shot.sequence).padStart(2, '0')}`}
      description={`只勾选这一镜真正用到的人物 / 武器 / 场景 / 道具，最多 ${KLING_OMNI_MAX_REFS} 个。勾选顺序即 prompt 里的 image_1、image_2…`}
      footer={
        <>
          <span
            className={`mr-auto self-center text-xs ${over ? 'text-destructive' : 'text-muted'}`}
          >
            已选 {effective.length} / {KLING_OMNI_MAX_REFS}
            {over ? ` · 超出 ${effective.length - KLING_OMNI_MAX_REFS} 个，无法保存` : ''}
          </span>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={over || saving}>
            保存
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded-md border border-border bg-background-soft-2/60 p-3 text-xs leading-relaxed">
        <p className="text-foreground">
          参考策略：视频接口最多 {KLING_OMNI_MAX_REFS} 张。多人动作镜头优先考虑「1 张场景/关系母图 + 核心人物 + 核心武器/道具」，不要用重复定妆图浪费名额。
        </p>
        <p className="mt-1 text-muted">
          当前：角色 {mixAdvice.characterCount} · 素材 {mixAdvice.materialCount} · 合计 {mixAdvice.total}
        </p>
        {mixAdvice.warning && (
          <p className="mt-1 text-amber-400">{mixAdvice.warning}</p>
        )}
      </div>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted">
          没有可用图片。请先给出场角色上传参考图并锁定，或在项目素材里上传图片。
        </p>
      ) : (
        <ul className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
          {candidates.map((c) => {
            const asset = assetById.get(c.assetId)
            const order = effective.indexOf(c.assetId)
            const checked = order >= 0
            return (
              <li key={c.assetId}>
                <label
                  className={`flex cursor-pointer flex-col gap-1.5 rounded-md border p-2 text-xs transition-colors ${
                    checked
                      ? 'border-accent bg-accent/10'
                      : 'border-border bg-background-soft-2/40 hover:border-accent/50'
                  }`}
                >
                  <div className="relative aspect-video w-full overflow-hidden rounded bg-background-soft-2">
                    {asset && (
                      <img
                        src={getObjectURL(asset)}
                        alt={c.label}
                        className="absolute inset-0 h-full w-full object-cover"
                        loading="lazy"
                      />
                    )}
                    {checked && (
                      <span className="absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded bg-accent px-1 font-mono text-[10px] text-white">
                        {order + 1}
                      </span>
                    )}
                  </div>
                  <span className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(c.assetId)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="truncate text-foreground" title={c.label}>
                      {c.label}
                    </span>
                    {checked && <Check className="ml-auto h-3 w-3 text-accent" />}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </Modal>
  )
}
