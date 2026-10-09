import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKlingOmniClient } from '@/core/video/kling-omni-client'
import {
  checkOmniAssetTransport,
  testOmniR2RoundTrip,
  uploadOmniReferences,
  usesOmniR2Transport,
} from '@/core/video/omni-asset-upload'
import { mockFetch, pngBlob, type RecordedCall } from './helpers'

const root = 'https://dramai-kling-proxy.gaofeng0501gf.workers.dev'
const proxy = { baseUrl: root, apiKey: 'test-proxy-token', model: 'kling-v3-omni' }
const urlFor = (n: number) => `${root}/v1/omni-assets/00000000-0000-4000-8000-${String(n).padStart(12, '0')}.png`
let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

describe('Omni R2 URL transmission', () => {
  it('only enables URL mode for the exact trusted dramai Worker', () => {
    assert.equal(usesOmniR2Transport(root), true)
    assert.equal(usesOmniR2Transport(`${root}/`), true)
    assert.equal(usesOmniR2Transport('https://api-beijing.klingai.com'), false)
    assert.equal(usesOmniR2Transport('https://dramai-kling-proxy.gaofeng0501gf.workers.dev.evil.test'), false)
  })

  it('uploads reference images in order and submits only URLs, never Base64', async () => {
    let uploads = 0
    const m = mockFetch((call: RecordedCall) => {
      if (call.url.endsWith('/status')) return { ready: true, maxBytes: 10485760 }
      if (call.url.endsWith('/v1/omni-assets')) {
        uploads += 1
        assert.equal(call.method, 'POST')
        assert.equal(call.headers.Authorization, 'Bearer test-proxy-token')
        assert.equal(call.headers['Content-Type'], 'image/png')
        assert.ok(call.body instanceof Blob)
        return { url: urlFor(uploads) }
      }
      if (call.url.endsWith('/v1/videos/omni-video')) {
        return { code: 0, data: { task_id: 'T-A7' } }
      }
      throw new Error('unexpected URL: ' + call.url)
    })
    restore = m.restore
    const input = [pngBlob('scene'), pngBlob('shen'), pngBlob('boss')]
    const task = await createKlingOmniClient(proxy).submit({
      model: 'kling-v3-omni',
      prompt: '晏无归左鞘撞剑',
      durationSec: 7,
      referenceImageBlobs: input.map((blob) => ({ blob })),
    })
    assert.equal(task.taskId, 'T-A7')
    assert.equal(uploads, 3)
    assert.deepEqual(m.calls.map((c) => c.url), [
      `${root}/v1/omni-assets/status`,
      `${root}/v1/omni-assets`,
      `${root}/v1/omni-assets`,
      `${root}/v1/omni-assets`,
      `${root}/v1/videos/omni-video`,
    ])
    const final = m.calls.at(-1)?.body as { image_list: Array<{ image_url: string }>; prompt: string }
    assert.deepEqual(final.image_list, [1, 2, 3].map((n) => ({ image_url: urlFor(n) })))
    assert.equal(final.prompt, '晏无归左鞘撞剑')
    assert.ok(JSON.stringify(final).length < 1024, 'final Kling POST stays small')
  })

  it('does not contact Kling when R2 is unavailable or an image upload fails', async () => {
    const missing = mockFetch(() => new Response('{"error":"r2_not_configured"}', { status: 503 }))
    restore = missing.restore
    await assert.rejects(checkOmniAssetTransport(proxy), /尚未绑定 R2/)
    await assert.rejects(
      createKlingOmniClient(proxy).submit({
        model: 'kling-v3-omni', prompt: 'x', referenceImageBlobs: [{ blob: pngBlob('x') }],
      }),
      /尚未绑定 R2/,
    )
    assert.ok(missing.calls.every((c) => !c.url.endsWith('/omni-video')))
    missing.restore()

    const failed = mockFetch((call) => {
      if (call.url.endsWith('/status')) return { ready: true }
      if (call.url.endsWith('/v1/omni-assets')) return new Response('upload error', { status: 502 })
      throw new Error('Kling POST must not be called')
    })
    restore = failed.restore
    await assert.rejects(
      createKlingOmniClient(proxy).submit({
        model: 'kling-v3-omni', prompt: 'x', referenceImageBlobs: [{ blob: pngBlob('x') }],
      }),
      /尚未提交可灵视频任务/,
    )
    assert.equal(failed.calls.length, 2)
  })

  it('rejects oversize or unsupported uploads before sending body', async () => {
    const m = mockFetch(() => ({ ready: true }))
    restore = m.restore
    await assert.rejects(
      uploadOmniReferences(proxy, [{ blob: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' }) }]),
      /10MiB/,
    )
    await assert.rejects(
      uploadOmniReferences(proxy, [{ blob: new Blob(['abc'], { type: 'image/webp' }) }]),
      /PNG\/JPEG/,
    )
    assert.equal(m.calls.filter((c) => c.method === 'POST').length, 0)
  })

  it('free R2 roundtrip only uploads/reads/deletes a tiny synthetic PNG, no Kling POST', async () => {
    const m = mockFetch((call) => {
      if (call.url.endsWith('/status')) return { ready: true }
      if (call.url.endsWith('/v1/omni-assets')) return { url: urlFor(1) }
      if (call.url === urlFor(1) && call.method === 'GET') {
        const raw = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
          'base64',
        )
        return new Response(raw, { status: 200 })
      }
      if (call.url === urlFor(1) && call.method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error('unexpected call')
    })
    restore = m.restore
    await testOmniR2RoundTrip(proxy)
    assert.deepEqual(m.calls.map((c) => c.method), ['GET', 'POST', 'GET', 'DELETE'])
    assert.ok(m.calls.every((c) => !c.url.endsWith('/omni-video')))
  })
})
