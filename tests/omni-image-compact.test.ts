import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactOmniReferences,
  DRAMAI_KLING_PROXY_HOST,
  estimatedBase64Bytes,
  isDramaiOmniProxy,
  OMNI_COMPACT_STAGES,
  OMNI_DIRECT_MAX_POST_BYTES,
} from '@/core/video/omni-image-compact'
import { createKlingOmniClient } from '@/core/video/kling-omni-client'
import { mockFetch, pngBlob } from './helpers'

const proxy = {
  baseUrl: `https://${DRAMAI_KLING_PROXY_HOST}`,
  apiKey: 'test-proxy-token',
  model: 'kling-v3-omni',
}
let restoreFetch: (() => void) | undefined
afterEach(() => restoreFetch?.())

describe('Kling Omni single-click compact direct transport', () => {
  it('uses existing dramai Worker only; no R2 or KV endpoints', () => {
    assert.equal(isDramaiOmniProxy(proxy.baseUrl), true)
    assert.equal(isDramaiOmniProxy(`${proxy.baseUrl}/`), true)
    assert.equal(isDramaiOmniProxy('https://api-beijing.klingai.com'), false)
    assert.equal(isDramaiOmniProxy(`https://${DRAMAI_KLING_PROXY_HOST}.evil.example`), false)
    assert.equal(OMNI_COMPACT_STAGES.at(-1)?.maxEdge, 1600)
    assert.equal(OMNI_COMPACT_STAGES.at(-1)?.quality, 0.84)
  })

  it('already-small images remain byte-for-byte untouched and in reference order', async () => {
    const originals = [
      { name: '主场景', blob: pngBlob('scene') },
      { name: '沈昭', blob: pngBlob('shen') },
      { name: '晏无归', blob: pngBlob('boss') },
    ]
    const result = await compactOmniReferences(originals, {
      encode: async () => {
        throw new Error('should not compress small images')
      },
    })
    assert.deepEqual(result.map((r) => r.name), originals.map((r) => r.name))
    assert.ok(result.every((r, i) => r.blob === originals[i].blob))
    assert.equal(estimatedBase64Bytes(originals[0].blob) % 4, 0)
  })

  it('large references adaptively compress without changing originals or order', async () => {
    const originals = Array.from({ length: 7 }, (_, i) => ({
      name: `ref-${i + 1}`,
      blob: new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' }),
    }))
    const calls: number[] = []
    const result = await compactOmniReferences(originals, {
      encode: async (_original, stage) => {
        calls.push(stage.maxEdge)
        return new Blob([new Uint8Array(400 * 1024)], { type: 'image/jpeg' })
      },
    })
    assert.ok(calls.length > 0)
    assert.deepEqual(result.map((r) => r.name), originals.map((r) => r.name))
    assert.ok(result.reduce((n, ref) => n + estimatedBase64Bytes(ref.blob), 0) < 5 * 1024 * 1024)
    assert.ok(originals.every((r) => r.blob.size === 2 * 1024 * 1024))
    assert.ok(originals.every((r) => r.blob.type === 'image/png'))
  })

  it('fails closed when the safe quality floor still exceeds 5MiB', async () => {
    const refs = Array.from({ length: 7 }, () => ({
      blob: new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' }),
    }))
    await assert.rejects(
      compactOmniReferences(refs, {
        encode: async () =>
          new Blob([new Uint8Array(1 * 1024 * 1024)], { type: 'image/jpeg' }),
      }),
      /停止压缩和视频提交/,
    )
  })

  it('7 large images submit one ≤5MiB JSON via old Worker with no storage calls', async () => {
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
    const canvasDraws: Array<{ width: number; height: number; quality: number }> = []
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        fillStyle: '#777777',
        fillRect: () => undefined,
        drawImage: () => canvasDraws.push({ width: canvas.width, height: canvas.height, quality: 0 }),
      }),
      toBlob: (callback: (blob: Blob) => void, _mime: string, quality: number) => {
        if (canvasDraws.length) canvasDraws[canvasDraws.length - 1].quality = quality
        callback(new Blob([new Uint8Array(420 * 1024)], { type: 'image/jpeg' }))
      },
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => canvas },
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: async () => ({
        width: 2600,
        height: 1700,
        close: () => undefined,
      }),
    })
    const m = mockFetch(() => ({ code: 0, data: { task_id: 'direct-task-7' } }))
    restoreFetch = m.restore
    try {
      const originals = Array.from({ length: 7 }, (_, i) => ({
        blob: new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' }),
        name: `人物${i + 1}`,
      }))
      const h = await createKlingOmniClient(proxy).submit({
        model: 'kling-v3-omni',
        prompt: '沈昭右手直剑，晏无归左手刀鞘撞剑',
        durationSec: 7,
        aspectRatio: '16:9',
        referenceImageBlobs: originals,
      })
      assert.equal(h.taskId, 'direct-task-7')
      assert.equal(m.calls.length, 1)
      assert.ok(m.calls[0].url.endsWith('/v1/videos/omni-video'))
      const body = m.calls[0].body as {
        image_list: Array<{ image_url: string }>
        sound: string
        duration: string
        mode: string
      }
      assert.equal(body.image_list.length, 7)
      assert.ok(body.image_list.every((r) => !r.image_url.startsWith('https:')))
      assert.equal(body.duration, '7')
      assert.equal(body.sound, 'on')
      assert.equal(body.mode, 'pro')
      assert.ok(new TextEncoder().encode(JSON.stringify(body)).byteLength <= OMNI_DIRECT_MAX_POST_BYTES)
      assert.ok(canvasDraws.length > 0)
      assert.ok(canvasDraws.every((x) => x.width <= 2400 && x.height <= 2400))
      assert.ok(originals.every((r) => r.blob.size === 2 * 1024 * 1024))
    } finally {
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      if (oldBitmap) Object.defineProperty(globalThis, 'createImageBitmap', oldBitmap)
      else Reflect.deleteProperty(globalThis, 'createImageBitmap')
    }
  })

  it('image processing failure is local and cannot create a charged video task', async () => {
    const refs = Array.from({ length: 7 }, () => ({
      blob: new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' }),
    }))
    const m = mockFetch(() => {
      throw new Error('Unexpected paid Kling request')
    })
    restoreFetch = m.restore
    await assert.rejects(
      createKlingOmniClient(proxy).submit({
        model: 'kling-v3-omni',
        prompt: 'A段',
        referenceImageBlobs: refs,
      }),
      /参考图压缩需要浏览器图像处理能力|参考图无法解码/,
    )
    assert.equal(m.calls.length, 0)
  })
})
