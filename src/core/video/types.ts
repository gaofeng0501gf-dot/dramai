import type { ApiFlavor } from '@/types/domain'

export interface I2VRequest {
  model: string
  prompt: string
  /**
   * 起始帧。普通 image2video（openai-compatible / kling / volcengine / aliyun）必填；
   * kling-omni 不使用。为兼容旧调用保留字段名，仅改为可选。
   */
  imageBlob?: Blob
  /**
   * Kling Omni 多参考图（人物 / 武器 / 场景 / 道具）。按顺序对应
   * prompt 里的 <<<image_1>>>、<<<image_2>>>…；其它协议忽略。
   */
  referenceImageBlobs?: Array<{
    blob: Blob
    name?: string
  }>
  /** 整数秒，常见值 5 / 10。 */
  durationSec?: number
  /** "9:16" / "16:9" / "1:1" 等。 */
  aspectRatio?: string
  /** 让 client 把它翻译成各家协议自己的运镜字段。 */
  cameraInstruction?: string
  signal?: AbortSignal
}

export interface I2VTaskHandle {
  taskId: string
  apiFlavor: ApiFlavor
}

export type I2VStatus =
  | { kind: 'queued' }
  | { kind: 'processing'; progress?: number; message?: string }
  | { kind: 'succeeded'; videoUrl: string; durationSec?: number }
  | { kind: 'failed'; message: string }

export interface I2VClient {
  /** 提交一个图生视频任务，立刻返回 task handle。不在这里下载视频。 */
  submit(req: I2VRequest): Promise<I2VTaskHandle>
  /** 轮询任务状态。succeeded 时返回视频 URL，调用方负责下载。 */
  poll(handle: I2VTaskHandle, signal?: AbortSignal): Promise<I2VStatus>
}
