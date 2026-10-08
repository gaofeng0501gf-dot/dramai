import type { ApiFlavor, Character, Material, Provider, Storyboard } from '@/types/domain'

/**
 * Kling Omni 相关的纯函数 / 常量。
 *
 * 刻意不依赖 Dexie / React，方便在 node:test 里直接测，也方便
 * video-shot、按钮、选择器共用同一套"是否可生视频"判断，避免各处口径漂移。
 */

export const KLING_OMNI_FLAVOR = 'kling-omni' as const satisfies ApiFlavor
export const KLING_OMNI_MODEL = 'kling-v3-omni'
export const KLING_OMNI_DEFAULT_BASE_URL = 'https://api-beijing.klingai.com'
export const KLING_OMNI_SUBMIT_PATH = '/v1/videos/omni-video'
/**
 * 官方限制：无参考视频时「参考图 + 多图主体」≤ 7。
 * dramai 目前只发参考图，UI 与 pipeline 统一硬限制 7 个。
 */
export const KLING_OMNI_MAX_REFS = 7
/** 官方 prompt 上限 2500 字符。 */
export const KLING_OMNI_PROMPT_MAX = 2500
/** 官方 duration 枚举 '3' ~ '15'。 */
export const KLING_OMNI_MIN_DURATION = 3
export const KLING_OMNI_MAX_DURATION = 15

export const OMNI_CINEMATIC_EXECUTION_RULE =
  '执行标准：顶级中国3D动画电影级、风格化半写实；动作按预备→接触→施力→完成→反应完整发生，脚步、重心、腰胯、武器重量与惯性真实，接触先于位移；特效必须由动作因果触发，采用克制的东方视觉语汇，禁止无来源光束、粒子污染和游戏式爆炸；风雨、水膜、衣料、旗帜、锁链、石屑随受力产生二次响应；镜头服务空间关系与力量传递，不无意义乱飞或环绕；冲击点只允许极短轻震，关键接触可短促减速，禁止漂浮、布偶和无接触击飞。'

export const OMNI_ERR_NO_REFS = '请先选择 Omni 参考素材'
export const omniErrTooMany = (n: number) =>
  `Omni 参考素材最多 ${KLING_OMNI_MAX_REFS} 个，当前 ${n} 个，请删减后再提交`

export function isKlingOmni(provider: Pick<Provider, 'apiFlavor'> | undefined | null): boolean {
  return provider?.apiFlavor === KLING_OMNI_FLAVOR
}

/** 保序去重，并丢掉空值。 */
export function dedupeAssetIds(ids: ReadonlyArray<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export type OmniRefValidation = { ok: true; ids: string[] } | { ok: false; error: string }

/** 提交前 / 保存前统一校验：去重后必须 1~7 个。 */
export function validateOmniReferenceIds(
  ids: ReadonlyArray<string | undefined | null> | undefined,
): OmniRefValidation {
  const clean = dedupeAssetIds(ids ?? [])
  if (clean.length === 0) return { ok: false, error: OMNI_ERR_NO_REFS }
  if (clean.length > KLING_OMNI_MAX_REFS) return { ok: false, error: omniErrTooMany(clean.length) }
  return { ok: true, ids: clean }
}

/**
 * 某个分镜在当前视频 provider 下能不能直接点「生视频」。
 *   - 普通 image2video：必须有起始图 imageAssetId（原行为）
 *   - kling-omni：只要选了 Omni 参考素材，不需要起始图
 */
export function isShotVideoReady(
  shot: Pick<Storyboard, 'imageAssetId' | 'referenceAssetIds'>,
  provider: Pick<Provider, 'apiFlavor'> | undefined | null,
): boolean {
  if (isKlingOmni(provider)) return dedupeAssetIds(shot.referenceAssetIds ?? []).length > 0
  return Boolean(shot.imageAssetId)
}

/** 选择器里的一个候选参考图。 */
export interface OmniCandidate {
  assetId: string
  label: string
  source: 'character' | 'material'
}

/**
 * 选择器候选列表：
 *   A. 当前分镜绑定、且已锁定、且有参考图的角色
 *   B. 项目 materials 里 kind=image 且有 assetId 的素材
 * 按 assetId 去重（同一张图既是角色参考又是素材时，优先显示角色名）。
 */
export function buildOmniCandidates(
  shot: Pick<Storyboard, 'characterIds'>,
  characters: ReadonlyArray<Pick<Character, 'id' | 'name' | 'locked' | 'referenceAssetId'>>,
  materials: ReadonlyArray<Pick<Material, 'kind' | 'name' | 'assetId'>>,
): OmniCandidate[] {
  const out: OmniCandidate[] = []
  const seen = new Set<string>()
  const byId = new Map(characters.map((c) => [c.id, c]))
  for (const cid of shot.characterIds) {
    const c = byId.get(cid)
    if (!c || !c.locked || !c.referenceAssetId || seen.has(c.referenceAssetId)) continue
    seen.add(c.referenceAssetId)
    out.push({ assetId: c.referenceAssetId, label: `角色·${c.name}`, source: 'character' })
  }
  for (const m of materials) {
    if (m.kind !== 'image' || !m.assetId || seen.has(m.assetId)) continue
    seen.add(m.assetId)
    out.push({ assetId: m.assetId, label: m.name, source: 'material' })
  }
  return out
}

export interface OmniReferenceMixAdvice {
  total: number
  characterCount: number
  materialCount: number
  warning?: string
}

/**
 * 参考位配比提示。7 张是视频接口硬上限；这里只做创作质量提醒，不擅自改用户选择。
 */
export function omniReferenceMixAdvice(
  selected: ReadonlyArray<Pick<OmniCandidate, 'source'>>,
): OmniReferenceMixAdvice {
  const characterCount = selected.filter((x) => x.source === 'character').length
  const materialCount = selected.length - characterCount
  const warning =
    selected.length >= 5 && materialCount === 0
      ? '当前参考位全部是角色图。多人动作镜头建议至少给场景/关系母图或关键武器/道具留 1–3 个位置，避免 7 个名额全被人物定妆占满。'
      : undefined
  return { total: selected.length, characterCount, materialCount, warning }
}

/**
 * 识别 sceneText 中明确写出的角色对白：`角色名（状态）：“台词”` / `角色名:"台词"` /
 * `角色名：「台词」` 这类「说话人 + 冒号 + 引号」结构。
 * 普通的引号用法（如 名为“斩龙钉”）没有说话人冒号，不算对白。
 */
const DIALOGUE_RE = /[^\s。！？；，、,!?;\n“”「」『』"]{1,12}[：:]\s*[“"「『][^”"」』\n]*[”"」』]/g

export function extractExplicitDialogue(sceneText: string): string[] {
  return (sceneText.match(DIALOGUE_RE) ?? []).map((l) => l.trim())
}

/**
 * 原生声音 / 对白约束。
 *   - 环境声与动作音效始终保留；
 *   - 无明确对白：禁止生成任何对白、口播或旁白；
 *   - 有明确对白：只逐字生成这些对白，不得新增、改写或补充台词。
 */
export function buildOmniAudioRule(sceneText: string): string {
  const lines = extractExplicitDialogue(sceneText)
  const base = '声音：保留原生环境声和动作音效。'
  if (lines.length === 0) {
    return `${base}本镜 sceneText 没有明确写出角色对白：禁止生成任何对白、口播或旁白。`
  }
  return `${base}本镜只允许 sceneText 中明确写出的对白，逐字照读：${lines.join(' ')}；不得新增台词，不得改写或补充台词；除此之外禁止任何对白、口播或旁白。`
}

/** 超长截断时中间的连接标记。 */
export const OMNI_CLIP_MARKER = '……（中段略）……'
const HEAD_RATIO = 0.65

/**
 * 把 sceneText 压到 room 字符以内：保留开头 65%（起始状态、核心动作）
 * 和结尾 35%（最后一拍、下一段衔接、最终对白），中间用标记连接。
 */
export function clipSceneHeadTail(scene: string, room: number): string {
  if (scene.length <= room) return scene
  const avail = room - OMNI_CLIP_MARKER.length
  if (avail <= 0) return scene.slice(scene.length - Math.max(0, room))
  const head = Math.ceil(avail * HEAD_RATIO)
  const tail = avail - head
  return `${scene.slice(0, head)}${OMNI_CLIP_MARKER}${tail > 0 ? scene.slice(-tail) : ''}`
}

/**
 * Omni 视频 prompt。
 *
 * 与普通 image2video（imagePrompt + sceneText + 运镜）不同：imagePrompt 是静态
 * 关键帧描述，拿来当动作视频主体会把人物锁死成静态构图，所以这里**不用**
 * imagePrompt，而是：
 *   sceneText（完整动作过程，原文保留）
 *   + 运镜
 *   + <<<image_N>>> 参考说明 + 人物 / 武器 / 场景一致性约束
 *   + 声音 / 对白约束（见 buildOmniAudioRule）
 * 总长不超过 Kling 上限 2500 字符；超长时 sceneText 头尾保留、中段压缩。
 */
export function buildOmniPrompt(input: {
  sceneText: string
  cameraInstruction?: string
  referenceNames: ReadonlyArray<string | undefined>
}): string {
  const scene = input.sceneText.trim()
  const refs = input.referenceNames.map(
    (name, i) => `<<<image_${i + 1}>>>${name ? `为「${name}」` : ''}`,
  )
  const tail: string[] = []
  if (input.cameraInstruction) tail.push(`镜头：${input.cameraInstruction}`)
  if (refs.length > 0) tail.push(`参考：${refs.join('；')}`)
  tail.push(
    '一致性：人物五官、发型、服饰，武器与道具的形制，以及场景布局都与对应参考图保持一致；动作完整连贯，不要停在静态构图。',
  )
  tail.push(OMNI_CINEMATIC_EXECUTION_RULE)
  tail.push(buildOmniAudioRule(scene))
  const suffix = tail.join('\n')
  // 参考说明、一致性与声音约束必须完整发出；sceneText 用剩余空间，头尾保留
  const room = KLING_OMNI_PROMPT_MAX - suffix.length - 1
  const sceneClipped = clipSceneHeadTail(scene, Math.max(0, room))
  return [sceneClipped, suffix].filter(Boolean).join('\n').slice(0, KLING_OMNI_PROMPT_MAX)
}

/** 把任意秒数夹到官方枚举 '3'~'15'。 */
export function toOmniDuration(sec: number | undefined): string {
  const n = Math.round(Number.isFinite(sec) ? (sec as number) : 5)
  return String(Math.min(KLING_OMNI_MAX_DURATION, Math.max(KLING_OMNI_MIN_DURATION, n)))
}

/**
 * 解析分镜的 Omni 参考素材为 Blob 列表。asset 读取以函数注入，
 * 让 pipeline 用 Dexie、测试用内存 Map。
 */
export async function resolveOmniReferenceBlobs(
  ids: ReadonlyArray<string> | undefined,
  getAsset: (id: string) => Promise<{ blob: Blob; kind?: string } | undefined>,
  nameOf: (id: string) => string | undefined = () => undefined,
): Promise<
  { ok: true; refs: Array<{ blob: Blob; name?: string }> } | { ok: false; error: string }
> {
  const v = validateOmniReferenceIds(ids)
  if (!v.ok) return v
  const refs: Array<{ blob: Blob; name?: string }> = []
  for (const id of v.ids) {
    const a = await getAsset(id)
    if (!a) return { ok: false, error: `Omni 参考素材缺失（asset ${id} 已被删除），请重新选择` }
    if (a.kind && a.kind !== 'image') return { ok: false, error: `Omni 参考素材 ${id} 不是图片` }
    refs.push({ blob: a.blob, name: nameOf(id) })
  }
  return { ok: true, refs }
}

/**
 * 旧「生图」入口（批量生图 / 单镜生图）是否显示。
 * Kling Omni 不需要起始图，隐藏入口；生图能力本身不删除，切回其它协议即恢复。
 */
export function showImageGenerationEntry(
  provider: Pick<Provider, 'apiFlavor'> | undefined | null,
): boolean {
  return !isKlingOmni(provider)
}

/** 普通 image2video 模式的分镜状态文案（与 v0.4.1 一致）。 */
export const STORYBOARD_STATUS_LABEL: Record<Storyboard['status'], string> = {
  pending: '待生图',
  'image-ready': '图已生成',
  'video-ready': '视频已生成',
  failed: '失败',
}

/**
 * 分镜状态文案。
 *   普通模式：待生图 / 图已生成 / 视频已生成 / 失败（原样）
 *   Kling Omni：待选参考 → 待生视频 → 视频已生成（失败仍显示「失败」）
 */
export function storyboardStatusLabel(
  shot: Pick<Storyboard, 'status' | 'videoAssetId' | 'referenceAssetIds'>,
  provider: Pick<Provider, 'apiFlavor'> | undefined | null,
): string {
  if (!isKlingOmni(provider)) return STORYBOARD_STATUS_LABEL[shot.status]
  if (shot.videoAssetId || shot.status === 'video-ready') return '视频已生成'
  if (shot.status === 'failed') return STORYBOARD_STATUS_LABEL.failed
  if (dedupeAssetIds(shot.referenceAssetIds ?? []).length === 0) return '待选参考'
  return '待生视频'
}
