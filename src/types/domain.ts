/**
 * 域模型 — dramai 的核心实体类型。
 *
 * 这些类型同时被 Zustand store、Dexie schema、AI 客户端协议共享。
 * 任何字段变更都意味着一次 IndexedDB 迁移（修改 src/core/storage/db.ts 的
 * version 号 + stores 描述）。
 */

export type ProviderKind = 'llm' | 'text2image' | 'image2video' | 'imageEdit'

/**
 * 协议风格。
 *  - 'openai-compatible' (默认)  → /v1/chat/completions、/v1/images/generations 等
 *  - 'gemini'                    → 文生图走 /v1beta/models/{model}:generateContent
 *                                  （302 上的 Nano Banana / Imagen / Google AI Studio 等）
 *  - 'volcengine'                → 火山方舟（字节即梦 Seedance / Doubao 视频）
 *                                  POST /volcengine/api/v3/contents/generations/tasks
 *                                  + GET 轮询；body 用 multimodal content 数组
 *  - 'kling'                     → image2video 走 /v1/videos/image2video（Kling 原生）
 *  - 'kling-omni'                → Kling 3.0 Omni 原生多参考视频
 *                                  POST /v1/videos/omni-video + GET /v1/videos/omni-video/{task_id}
 *                                  不需要起始帧，直接用分镜选中的参考素材（≤7 张）
 *  - 'runway'                    → image2video Runway 原生（v0.4 暂回退到通用）
 */
export type ApiFlavor =
  | 'openai-compatible'
  | 'gemini'
  | 'volcengine'
  | 'aliyun'
  | 'kling'
  | 'kling-omni'
  | 'runway'

export interface Provider {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
  notes?: string
  /** 默认 'openai-compatible'。仅 image2video provider 上影响行为。 */
  apiFlavor?: ApiFlavor
  /** 仅在测试连接成功后写入。 */
  lastVerifiedAt?: number
}

export type ActiveProviderMap = Partial<Record<ProviderKind, string>>

export type ProjectStatus = 'draft' | 'storyboarding' | 'generating' | 'done'

export interface Project {
  id: string
  title: string
  summary?: string
  style?: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
}

export type CharacterRole = 'protagonist' | 'supporting' | 'extra'

export interface Character {
  id: string
  projectId: string
  name: string
  description?: string
  role: CharacterRole
  /** 关联到 assets 表里的参考图。 */
  referenceAssetId?: string
  /** 当为 true 时，分镜里出场会直接使用 referenceAssetId 作为图生图源图。 */
  locked: boolean
  createdAt: number
}

export type MaterialKind = 'doc' | 'txt' | 'md' | 'image'

export interface Material {
  id: string
  projectId: string
  kind: MaterialKind
  name: string
  /** 解析后的文本内容（image 类型为空字符串）。 */
  text: string
  /** 关联到 assets 表的原始文件。 */
  assetId?: string
  createdAt: number
}

export type CameraMovement =
  | 'static'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'zoom_in'
  | 'zoom_out'
  | 'orbit_left'
  | 'orbit_right'
  | 'dolly_in'
  | 'dolly_out'

export type CameraSpeed = 'slow' | 'normal' | 'fast'

export interface CameraParams {
  movement: CameraMovement
  speed?: CameraSpeed
}

export interface Storyboard {
  id: string
  projectId: string
  sequence: number
  sceneText: string
  narration?: string
  imagePrompt?: string
  /** 出场角色的 character.id 列表。 */
  characterIds: string[]
  durationSec?: number
  imageAssetId?: string
  videoAssetId?: string
  /** 运镜参数。v0.3 起；旧分镜没有则按 static 处理。 */
  cameraParams?: CameraParams
  /**
   * Kling Omni 多参考素材：指向 assets 表里已有的图片 asset（角色锁定参考图 /
   * 项目 image 素材）。只存引用、不复制 Blob；每个分镜独立挑选，最多 7 个。
   * 删除分镜时**不能**连带删除这些 asset（它们属于角色/素材）。
   */
  referenceAssetIds?: string[]
  /**
   * 异步视频任务句柄，用于刷新页面后恢复轮询。
   * 任务结束后清空。
   */
  pendingVideoTask?: {
    taskId: string
    apiFlavor: ApiFlavor
    submittedAt: number
  }
  status: 'pending' | 'image-ready' | 'video-ready' | 'failed'
}

export type AssetKind = 'image' | 'video' | 'doc'

export interface Asset {
  id: string
  projectId: string
  kind: AssetKind
  /** 原始 mime type，例如 image/png、video/mp4。 */
  mimeType: string
  blob: Blob
  width?: number
  height?: number
  createdAt: number
}

export interface Generation {
  id: string
  projectId: string
  stageName: 'rewrite' | 'storyboard' | 'image' | 'camera' | 'video'
  status: 'pending' | 'running' | 'success' | 'failed'
  input: unknown
  output?: unknown
  error?: string
  retry: number
  createdAt: number
  finishedAt?: number
}
