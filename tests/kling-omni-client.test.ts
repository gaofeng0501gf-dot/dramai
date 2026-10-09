import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createKlingOmniClient,
  KlingOmniSubmissionUnknownError,
  resolveKlingAuthorization,
  signKlingLegacyJwt,
} from '@/core/video/kling-omni-client'
import { createVideoClient } from '@/core/video/factory'
import { b64, mockFetch, pngBlob, type RecordedCall } from './helpers'

const provider = {
  baseUrl: 'https://api-singapore.klingai.com/',
  apiKey: 'test-key',
  model: 'kling-v3-omni',
}

let restore: (() => void) | undefined
afterEach(() => restore?.())

function okSubmit(call: RecordedCall) {
  if (call.method === 'POST')
    return { code: 0, data: { task_id: 'task-123', task_status: 'submitted' } }
  return {
    code: 0,
    data: {
      task_status: 'succeed',
      task_result: { videos: [{ url: 'https://cdn.example/v.mp4', duration: '5.1' }] },
    },
  }
}

describe('Kling Omni client', () => {
  it('POST 到 /v1/videos/omni-video，body 字段符合官方 Omni 协议', async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createKlingOmniClient(provider)
    const handle = await client.submit({
      model: 'kling-v3-omni',
      prompt: '晏无归拔刀。晏无归：“这才像样。”',
      referenceImageBlobs: [
        { blob: pngBlob('hero'), name: '角色·晏无归' },
        { blob: pngBlob('blade'), name: '斩龙钉' },
      ],
      durationSec: 5,
      aspectRatio: '16:9',
    })

    assert.equal(handle.taskId, 'task-123')
    assert.equal(handle.apiFlavor, 'kling-omni')
    assert.equal(m.calls.length, 1)
    const call = m.calls[0]
    assert.equal(call.method, 'POST')
    assert.equal(call.url, 'https://api-singapore.klingai.com/v1/videos/omni-video')
    assert.equal(call.headers.Authorization, 'Bearer test-key')
    assert.equal(call.headers['Content-Type'], 'application/json')

    const body = call.body as Record<string, unknown>
    assert.equal(body.model_name, 'kling-v3-omni')
    assert.equal(body.sound, 'on')
    assert.equal(body.mode, 'pro')
    assert.equal(body.aspect_ratio, '16:9')
    assert.equal(body.duration, '5')
    assert.equal(body.prompt, '晏无归拔刀。晏无归：“这才像样。”')
    // referenceImageBlobs → image_list（按顺序，纯 base64，无 data: 前缀）
    assert.deepEqual(body.image_list, [
      { image_url: b64('fake-png-hero') },
      { image_url: b64('fake-png-blade') },
    ])
    // 不能混入旧 image2video 字段
    assert.equal('image' in body, false)
    assert.equal('cfg_scale' in body, false)
    assert.equal('camera_control' in body, false)
  })

  it('model 为空时回落到 kling-v3-omni；duration 夹到官方 3~15', async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createKlingOmniClient({ ...provider, model: '' })
    await client.submit({
      model: '',
      prompt: 'x',
      referenceImageBlobs: [{ blob: pngBlob('a') }],
      durationSec: 30,
    })
    const body = m.calls[0].body as Record<string, unknown>
    assert.equal(body.model_name, 'kling-v3-omni')
    assert.equal(body.duration, '15')
    assert.equal(body.aspect_ratio, '16:9')
  })

  it('poll 走 GET /v1/videos/omni-video/{task_id}，成功映射为 I2VStatus.succeeded', async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createKlingOmniClient(provider)
    const status = await client.poll({ taskId: 'task/123', apiFlavor: 'kling-omni' })
    assert.equal(m.calls[0].method, 'GET')
    assert.equal(
      m.calls[0].url,
      'https://api-singapore.klingai.com/v1/videos/omni-video/task%2F123',
    )
    assert.deepEqual(status, {
      kind: 'succeeded',
      videoUrl: 'https://cdn.example/v.mp4',
      durationSec: 5.1,
    })
  })

  it('poll 处理 processing / failed / submitted', async () => {
    const states = [
      { task_status: 'processing', task_status_msg: 'rendering' },
      { task_status: 'failed', task_status_msg: '内容不合规' },
      { task_status: 'submitted' },
    ]
    let i = 0
    const m = mockFetch(() => ({ code: 0, data: states[i++] }))
    restore = m.restore
    const client = createKlingOmniClient(provider)
    const h = { taskId: 't', apiFlavor: 'kling-omni' as const }
    assert.deepEqual(await client.poll(h), { kind: 'processing', message: 'rendering' })
    assert.deepEqual(await client.poll(h), { kind: 'failed', message: '内容不合规' })
    assert.deepEqual(await client.poll(h), { kind: 'queued' })
  })

  it('没有参考图禁止提交，且不发请求', async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createKlingOmniClient(provider)
    await assert.rejects(
      client.submit({ model: 'kling-v3-omni', prompt: 'x' }),
      /请先选择 Omni 参考素材/,
    )
    await assert.rejects(
      client.submit({ model: 'kling-v3-omni', prompt: 'x', referenceImageBlobs: [] }),
      /请先选择 Omni 参考素材/,
    )
    assert.equal(m.calls.length, 0)
  })

  it('超过 7 张参考图禁止提交，且不发请求；7 张可以', async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createKlingOmniClient(provider)
    const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ blob: pngBlob(String(i)) }))
    await assert.rejects(
      client.submit({ model: 'kling-v3-omni', prompt: 'x', referenceImageBlobs: refs(8) }),
      /最多 7 个/,
    )
    assert.equal(m.calls.length, 0)
    await client.submit({ model: 'kling-v3-omni', prompt: 'x', referenceImageBlobs: refs(7) })
    assert.equal((m.calls[0].body as { image_list: unknown[] }).image_list.length, 7)
  })

  it('提交网络异常时标记结果未知，不能提示安全重试', async () => {
    const m = mockFetch(() => { throw new TypeError('Failed to fetch') })
    restore = m.restore
    const client = createKlingOmniClient(provider)
    await assert.rejects(
      client.submit({ prompt: 'A', referenceImageBlobs: [{ blob: pngBlob('hero') }] }),
      KlingOmniSubmissionUnknownError,
    )
    assert.equal(m.calls.length, 1)
  })

  it('上游 502 或HTTP成功但缺少task_id都视为未知；明确4xx拒绝是确定错误', async () => {
    const h = { prompt: 'A', referenceImageBlobs: [{ blob: pngBlob('hero') }] }
    const m = mockFetch(() => new Response('bad gateway', { status: 502 }))
    restore = m.restore
    await assert.rejects(createKlingOmniClient(provider).submit(h), KlingOmniSubmissionUnknownError)
    m.restore()

    const noId = mockFetch(() => ({ code: 0, data: {} }))
    restore = noId.restore
    await assert.rejects(createKlingOmniClient(provider).submit(h), KlingOmniSubmissionUnknownError)
    noId.restore()

    const denied = mockFetch(() => new Response('bad request', { status: 400 }))
    restore = denied.restore
    await assert.rejects(createKlingOmniClient(provider).submit(h), /HTTP 400/)
  })

  it('业务 code≠0 视为提交失败', async () => {
    const m = mockFetch(() => ({ code: 1201, message: 'invalid image' }))
    restore = m.restore
    const client = createKlingOmniClient(provider)
    await assert.rejects(
      client.submit({
        model: 'kling-v3-omni',
        prompt: 'x',
        referenceImageBlobs: [{ blob: pngBlob('a') }],
      }),
      /1201/,
    )
  })
})

describe('Kling Omni 鉴权', () => {
  const spySigner = () => {
    const calls: Array<[string, string]> = []
    const sign = async (ak: string, sk: string) => {
      calls.push([ak, sk])
      return 'SIGNED'
    }
    return { calls, sign }
  }

  it('默认：普通 API Key kling_xxx 原样产生 Bearer kling_xxx（提交与轮询都是）', async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createKlingOmniClient({ ...provider, apiKey: 'kling_xxx' })
    const h = await client.submit({
      model: 'kling-v3-omni',
      prompt: 'x',
      referenceImageBlobs: [{ blob: pngBlob('a') }],
    })
    await client.poll(h)
    assert.equal(m.calls.length, 2)
    for (const c of m.calls) assert.equal(c.headers.Authorization, 'Bearer kling_xxx')
  })

  it('普通 API Key 不进入 JWT 签发逻辑（包括带冒号、形似 AK:SK 的 Key）', async () => {
    const spy = spySigner()
    assert.equal(await resolveKlingAuthorization('kling_xxx', spy.sign), 'Bearer kling_xxx')
    assert.equal(await resolveKlingAuthorization('  kling_xxx  ', spy.sign), 'Bearer kling_xxx')
    assert.equal(await resolveKlingAuthorization('ak123:sk456', spy.sign), 'Bearer ak123:sk456')
    assert.equal(
      await resolveKlingAuthorization('eyJhbGciOi.eyJpc3Mi.sig', spy.sign),
      'Bearer eyJhbGciOi.eyJpc3Mi.sig',
    )
    assert.equal(spy.calls.length, 0)
  })

  it('空 Key 不发 Authorization 头', async () => {
    assert.equal(await resolveKlingAuthorization('', spySigner().sign), undefined)
    assert.equal(await resolveKlingAuthorization(undefined, spySigner().sign), undefined)
  })

  it('legacy：仅显式 legacy-jwt:AK:SK 才签 JWT', async () => {
    const spy = spySigner()
    assert.equal(
      await resolveKlingAuthorization('legacy-jwt:ak123:sk456', spy.sign),
      'Bearer SIGNED',
    )
    assert.deepEqual(spy.calls, [['ak123', 'sk456']])
    await assert.rejects(resolveKlingAuthorization('legacy-jwt:onlyak', spy.sign), /legacy-jwt:/)
  })

  it('legacy：签出的 JWT 为 HS256，iss/exp/nbf 正确，签名可校验', async () => {
    const token = await signKlingLegacyJwt('ak123', 'sk456', 1_700_000_000)
    const [h, p, sig] = token.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), {
      alg: 'HS256',
      typ: 'JWT',
    })
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), {
      iss: 'ak123',
      exp: 1_700_001_800,
      nbf: 1_699_999_995,
    })
    const { createHmac } = await import('node:crypto')
    assert.equal(sig, createHmac('sha256', 'sk456').update(`${h}.${p}`).digest('base64url'))
  })

  it('legacy：客户端端到端发出 Bearer <JWT>', async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createKlingOmniClient({ ...provider, apiKey: 'legacy-jwt:ak123:sk456' })
    await client.submit({
      model: 'kling-v3-omni',
      prompt: 'x',
      referenceImageBlobs: [{ blob: pngBlob('a') }],
    })
    const auth = m.calls[0].headers.Authorization
    assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    assert.ok(!auth.includes('legacy-jwt'))
  })
})

describe('factory 路由', () => {
  it("apiFlavor='kling-omni' 走 Omni 客户端", async () => {
    const m = mockFetch(okSubmit)
    restore = m.restore
    const client = createVideoClient({
      id: 'p',
      label: 'omni',
      kind: 'image2video',
      apiFlavor: 'kling-omni',
      ...provider,
    })
    await client.submit({
      model: 'kling-v3-omni',
      prompt: 'x',
      referenceImageBlobs: [{ blob: pngBlob('a') }],
    })
    assert.match(m.calls[0].url, /\/v1\/videos\/omni-video$/)
  })
})
