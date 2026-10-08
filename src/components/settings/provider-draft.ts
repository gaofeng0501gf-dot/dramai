import type { ApiFlavor, Provider, ProviderKind } from '@/types/domain'
import { KLING_OMNI_DEFAULT_BASE_URL, KLING_OMNI_MODEL } from '@/core/video/omni'

/**
 * ProviderForm 的纯逻辑部分（无 React），便于单测。
 */

export const API_FLAVOR_LABEL: Record<ApiFlavor, string> = {
  'openai-compatible': 'OpenAI 兼容（默认 · 走 /v1/...）',
  gemini:
    'Gemini 原生（文生图专用 · 走 /v1beta/models/{model}:generateContent · Nano Banana / Imagen）',
  volcengine:
    '火山方舟 / 即梦（image2video · POST /volcengine/api/v3/contents/generations/tasks · Seedance）',
  aliyun:
    '阿里通义万相 / DashScope（image2video · POST /aliyun/api/v1/services/aigc/video-generation/video-synthesis · Wan / 欢乐马）',
  kling: 'Kling 原生（image2video 专用 · POST /v1/videos/image2video）',
  'kling-omni': 'Kling Omni 原生（多参考视频 · POST /v1/videos/omni-video · kling-v3-omni）',
  runway: 'Runway 原生（暂未完整接入，先按 OpenAI 兼容兜底）',
}

/** 某服务类型下可选的协议风格。 */
export function flavorsForKind(kind: ProviderKind): ApiFlavor[] {
  return (Object.keys(API_FLAVOR_LABEL) as ApiFlavor[]).filter((f) => {
    // 文生图：OpenAI 兼容 / Gemini 原生
    // 图生视频：OpenAI 兼容 / 火山方舟 / 阿里通义 / Kling / Kling Omni / Runway
    if (kind === 'text2image') return f === 'openai-compatible' || f === 'gemini'
    return f !== 'gemini'
  })
}

/** 选中某协议时建议自动填入的默认值（只在对应输入框为空时使用）。 */
export const FLAVOR_DEFAULTS: Partial<Record<ApiFlavor, { baseUrl: string; model: string }>> = {
  'kling-omni': { baseUrl: KLING_OMNI_DEFAULT_BASE_URL, model: KLING_OMNI_MODEL },
}

export type ProviderDraft = Omit<Provider, 'id' | 'lastVerifiedAt'>

export interface ProviderFormValues {
  label: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
  notes: string
  apiFlavor: ApiFlavor
}

/** 表单值 → 要保存的 Provider 草稿；必填项缺失返回 null。 */
export function toProviderDraft(v: ProviderFormValues): ProviderDraft | null {
  if (!v.label.trim() || !v.baseUrl.trim()) return null
  return {
    label: v.label.trim(),
    kind: v.kind,
    baseUrl: v.baseUrl.trim(),
    apiKey: v.apiKey.trim(),
    model: v.model.trim(),
    notes: v.notes.trim() || undefined,
    apiFlavor: v.kind === 'image2video' || v.kind === 'text2image' ? v.apiFlavor : undefined,
  }
}
