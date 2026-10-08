/**
 * 测试辅助：fetch 录制器 + Node 下缺失的 FileReader（旧 kling-client 用它转 base64）。
 */

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export function mockFetch(responder: (call: RecordedCall) => unknown) {
  const calls: RecordedCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    }
    calls.push(call)
    const payload = responder(call)
    if (payload instanceof Response) return payload
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

export function installFileReaderShim() {
  if ('FileReader' in globalThis) return
  class FileReaderShim {
    result: string | null = null
    error: Error | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(blob: Blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`
          this.onload?.()
        })
        .catch((e: Error) => {
          this.error = e
          this.onerror?.()
        })
    }
  }
  ;(globalThis as unknown as { FileReader: unknown }).FileReader = FileReaderShim
}

export const pngBlob = (tag: string) => new Blob([`fake-png-${tag}`], { type: 'image/png' })
export const b64 = (s: string) => Buffer.from(s).toString('base64')
