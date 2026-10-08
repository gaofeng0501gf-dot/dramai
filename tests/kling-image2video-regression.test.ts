import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKlingClient } from '@/core/video/kling-client'
import { createVideoClient } from '@/core/video/factory'
import { b64, installFileReaderShim, mockFetch, pngBlob } from './helpers'

/** 原 Kling image2video 不回归：端点、请求体、轮询端点保持 v0.4.1 行为。 */
let restore: (() => void) | undefined
before(() => installFileReaderShim())
afterEach(() => restore?.())

const provider = { baseUrl: 'https://kling.example/', apiKey: 'k', model: 'kling-v2-master' }

describe('Kling image2video（旧协议）不回归', () => {
  it('submit 仍走 /v1/videos/image2video，body 仍是 image 起始帧', async () => {
    const m = mockFetch(() => ({ data: { task_id: 'old-1' } }))
    restore = m.restore
    const handle = await createKlingClient(provider).submit({
      model: 'kling-v2-master',
      prompt: 'hero walks',
      imageBlob: pngBlob('frame'),
      cameraInstruction: 'static camera, no movement',
      durationSec: 5,
    })
    assert.deepEqual(handle, { taskId: 'old-1', apiFlavor: 'kling' })
    const call = m.calls[0]
    assert.equal(call.url, 'https://kling.example/v1/videos/image2video')
    const body = call.body as Record<string, unknown>
    assert.deepEqual(body, {
      model_name: 'kling-v2-master',
      image: b64('fake-png-frame'),
      prompt: 'hero walks. static camera, no movement',
      duration: '5',
    })
    assert.equal('image_list' in body, false)
    assert.equal('sound' in body, false)
  })

  it('poll 仍走 /v1/videos/image2video/{task_id}', async () => {
    const m = mockFetch(() => ({
      data: { task_status: 'succeed', task_result: { videos: [{ url: 'u', duration: 5 }] } },
    }))
    restore = m.restore
    const st = await createKlingClient(provider).poll({ taskId: 'old-1', apiFlavor: 'kling' })
    assert.equal(m.calls[0].url, 'https://kling.example/v1/videos/image2video/old-1')
    assert.deepEqual(st, { kind: 'succeeded', videoUrl: 'u', durationSec: 5 })
  })

  it("factory 对 apiFlavor='kling' 仍返回 image2video 客户端", async () => {
    const m = mockFetch(() => ({ data: { task_id: 'x' } }))
    restore = m.restore
    await createVideoClient({
      id: 'p',
      label: 'k',
      kind: 'image2video',
      apiFlavor: 'kling',
      ...provider,
    }).submit({
      model: 'm',
      prompt: 'p',
      imageBlob: pngBlob('f'),
    })
    assert.match(m.calls[0].url, /\/v1\/videos\/image2video$/)
  })

  it('普通 image2video 缺 imageBlob 时明确报错、不发请求', async () => {
    const m = mockFetch(() => ({}))
    restore = m.restore
    await assert.rejects(
      createKlingClient(provider).submit({ model: 'm', prompt: 'p' }),
      /缺少起始帧/,
    )
    assert.equal(m.calls.length, 0)
  })
})
