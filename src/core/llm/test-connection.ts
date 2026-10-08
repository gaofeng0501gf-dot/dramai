import type { Provider } from '@/types/domain'
import { resolveKlingAuthorization } from '@/core/video/kling-omni-client'

export interface TestConnectionResult {
  ok: boolean
  modelCount?: number
  detectedModels?: string[]
  error?: string
  status?: number
  /** 仅警告（非失败），用于"协议无标准列表端点"等情况。 */
  warning?: string
}

/**
 * 验证一个 provider 的 base URL + API key 是否真的能连。
 * 不同 apiFlavor 走不同的"列表"端点：
 *   - openai-compatible: GET {baseUrl}/models
 *   - gemini:            GET {baseUrl}/v1beta/models
 *   - kling-omni:        GET {baseUrl}/account/costs（Kling 官方免费的账户资源查询，
 *                        不提交任务、不产生视频费用），验证 Base URL / API Key / 浏览器 CORS
 *   - kling / runway:    无标准列表端点 → 返回 warning，让用户直接生成验证
 */
export async function testProvider(
  provider: Pick<Provider, 'baseUrl' | 'apiKey' | 'apiFlavor'>,
  options: { signal?: AbortSignal } = {},
): Promise<TestConnectionResult> {
  if (!provider.baseUrl) {
    return { ok: false, error: 'Base URL 不能为空' }
  }

  const flavor = provider.apiFlavor ?? 'openai-compatible'

  if (flavor === 'kling-omni') {
    return testKlingOmniAccount(provider, options)
  }

  if (flavor === 'kling' || flavor === 'runway') {
    return {
      ok: true,
      warning:
        '该协议没有标准的模型列表端点，无法在测试连接里验证；请直接在分镜上点「生视频」实测。',
    }
  }

  if (flavor === 'gemini') {
    return testGemini(provider, options)
  }

  return testOpenAICompat(provider, options)
}

async function testOpenAICompat(
  provider: Pick<Provider, 'baseUrl' | 'apiKey'>,
  options: { signal?: AbortSignal },
): Promise<TestConnectionResult> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      signal: options.signal,
    })
    if (!res.ok) {
      const detail = await safeText(res)
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${detail ? ` · ${detail.slice(0, 180)}` : ''}`,
      }
    }
    const data = (await res.json()) as unknown
    const list = extractModelList(data)
    return {
      ok: true,
      modelCount: list.length,
      detectedModels: list.slice(0, 8),
    }
  } catch (err) {
    return {
      ok: false,
      error: friendlyErr(err),
    }
  }
}

async function testGemini(
  provider: Pick<Provider, 'baseUrl' | 'apiKey'>,
  options: { signal?: AbortSignal },
): Promise<TestConnectionResult> {
  const root = provider.baseUrl.replace(/\/+$/, '')
  const url = `${root}/v1beta/models`
  const headers: Record<string, string> = {}
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
    headers['x-goog-api-key'] = provider.apiKey
  }
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: options.signal })
    if (!res.ok) {
      const detail = await safeText(res)
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${detail ? ` · ${detail.slice(0, 180)}` : ''}`,
      }
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    const list = (data.models ?? [])
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter(Boolean)
    return {
      ok: true,
      modelCount: list.length,
      detectedModels: list.slice(0, 8),
    }
  } catch (err) {
    return {
      ok: false,
      error: friendlyErr(err),
    }
  }
}

export const KLING_CORS_ERROR =
  'Kling 官方 API 当前无法从此浏览器 Origin 直连，请使用支持 CORS 的中转/后端代理。'

/** 账户资源查询的时间窗：最近 30 天（毫秒时间戳）。 */
const KLING_COSTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Kling Omni 零费用连通性检查：GET {baseUrl}/account/costs?start_time&end_time。
 * 只读查询，不提交任何视频任务。鉴权与生成时一致（默认 Bearer API Key）。
 *   - fetch 抛 TypeError（浏览器 CORS / 网络不可达）→ 明确的 CORS 提示
 *   - HTTP 非 2xx / 业务 code≠0 → 失败（多为 API Key 无效）
 */
export async function testKlingOmniAccount(
  provider: Pick<Provider, 'baseUrl' | 'apiKey'>,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<TestConnectionResult> {
  const root = provider.baseUrl.replace(/\/+$/, '')
  const end = options.now ?? Date.now()
  const query = new URLSearchParams({
    start_time: String(end - KLING_COSTS_WINDOW_MS),
    end_time: String(end),
  })
  const url = `${root}/account/costs?${query.toString()}`
  let headers: Record<string, string>
  try {
    const auth = await resolveKlingAuthorization(provider.apiKey)
    headers = auth ? { Authorization: auth } : {}
  } catch (err) {
    return { ok: false, error: friendlyErr(err) }
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers, signal: options.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, error: '已取消' }
    // 浏览器里 CORS 拦截与网络不可达都表现为 TypeError("Failed to fetch")
    return { ok: false, error: KLING_CORS_ERROR }
  }
  if (!res.ok) {
    const detail = await safeText(res)
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}${detail ? ` · ${detail.slice(0, 180)}` : ''}`,
    }
  }
  let json: { code?: number; message?: string }
  try {
    json = (await res.json()) as { code?: number; message?: string }
  } catch {
    return { ok: false, status: res.status, error: '响应不是 JSON，Base URL 可能填错' }
  }
  if (typeof json.code === 'number' && json.code !== 0) {
    return {
      ok: false,
      status: res.status,
      error: `Kling 业务错误 code ${json.code}: ${json.message ?? ''}`.trim(),
    }
  }
  return { ok: true }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function friendlyErr(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'AbortError' ? '已取消' : err.message
  }
  return String(err)
}

function extractModelList(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  const candidates: unknown[] = []
  if (Array.isArray(obj.data)) candidates.push(...(obj.data as unknown[]))
  else if (Array.isArray(obj.models)) candidates.push(...(obj.models as unknown[]))
  return candidates
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>
        return typeof e.id === 'string' ? e.id : typeof e.name === 'string' ? e.name : ''
      }
      return ''
    })
    .filter(Boolean)
}
