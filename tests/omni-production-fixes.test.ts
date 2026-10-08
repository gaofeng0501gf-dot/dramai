import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKlingOmniClient } from '@/core/video/kling-omni-client'
import {
  KLING_OMNI_PROMPT_MAX,
  OMNI_CLIP_MARKER,
  buildOmniPrompt,
  clipSceneHeadTail,
  extractExplicitDialogue,
} from '@/core/video/omni'
import { KLING_CORS_ERROR, testKlingOmniAccount, testProvider } from '@/core/llm/test-connection'
import { mockFetch } from './helpers'

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

const provider = { baseUrl: 'https://api-singapore.klingai.com', apiKey: 'kling_xxx', model: '' }

describe('修复1 · poll 业务错误码', () => {
  it('HTTP 200 + code≠0 直接 failed，不当 queued', async () => {
    const m = mockFetch(() => ({ code: 1102, message: '账户余额不足', data: {} }))
    restore = m.restore
    const st = await createKlingOmniClient(provider).poll({ taskId: 't', apiFlavor: 'kling-omni' })
    assert.deepEqual(st, { kind: 'failed', message: 'Kling Omni poll code 1102: 账户余额不足' })
  })

  it('code≠0 且 message 缺失时也直接 failed', async () => {
    const m = mockFetch(() => ({ code: 5000 }))
    restore = m.restore
    const st = await createKlingOmniClient(provider).poll({ taskId: 't', apiFlavor: 'kling-omni' })
    assert.deepEqual(st, { kind: 'failed', message: 'Kling Omni poll code 5000: ' })
  })

  it('code=0 时仍按 task_status 正常判断', async () => {
    const m = mockFetch(() => ({ code: 0, data: { task_status: 'submitted' } }))
    restore = m.restore
    const st = await createKlingOmniClient(provider).poll({ taskId: 't', apiFlavor: 'kling-omni' })
    assert.deepEqual(st, { kind: 'queued' })
  })
})

describe('修复2 · 原生声音 / 对白规则', () => {
  const actionScenes = {
    A: '雷雨夜，晏无归踏上宫阶，衣摆被雨水打湿。',
    B: '巨链从殿顶垂落，晏无归侧身闪过，链环擦过宫灯。',
    C: '他握住名为“斩龙钉”的长钉，雷光劈下。',
    D: '晏无归跃起，刀锋斩断第一节巨链，火星四溅。',
    E: '宫灯接连熄灭，晏无归落地单膝跪地。',
  }
  const F = '晏无归缓缓起身，收刀入鞘。晏无归（音量骤降）：“这才像样。”'

  for (const [k, scene] of Object.entries(actionScenes)) {
    it(`${k} 段无对白 → 禁止生成任何对白`, () => {
      const p = buildOmniPrompt({ sceneText: scene, referenceNames: ['角色·晏无归'] })
      assert.ok(p.includes('保留原生环境声和动作音效'))
      assert.ok(p.includes('禁止生成任何对白、口播或旁白'), p)
      assert.ok(!p.includes('逐字照读'))
      assert.ok(!p.includes('角色对白。'), '不得残留旧的“保留角色对白”表述')
    })
  }

  it('F 段有对白 → 原对白保留，只允许这一句，不得新增台词', () => {
    assert.deepEqual(extractExplicitDialogue(F), ['晏无归（音量骤降）：“这才像样。”'])
    const p = buildOmniPrompt({ sceneText: F, referenceNames: ['角色·晏无归'] })
    assert.ok(p.startsWith(F))
    assert.ok(p.includes('逐字照读：晏无归（音量骤降）：“这才像样。”'))
    assert.ok(p.includes('不得新增台词'))
    assert.ok(p.includes('不得改写或补充台词'))
    assert.ok(!p.includes('禁止生成任何对白'))
  })

  it('普通引号（名为“斩龙钉”）不算对白', () => {
    assert.deepEqual(extractExplicitDialogue(actionScenes.C), [])
  })
})

describe('修复3 · 超长截断保留头尾', () => {
  it('clipSceneHeadTail：65% 开头 + 35% 结尾 + 标记，长度不超 room', () => {
    const scene = `开头${'甲'.repeat(3000)}${'乙'.repeat(3000)}结尾`
    const out = clipSceneHeadTail(scene, 1000)
    assert.equal(out.length, 1000)
    assert.ok(out.startsWith('开头'))
    assert.ok(out.endsWith('结尾'))
    assert.ok(out.includes(OMNI_CLIP_MARKER))
    const [head, tail] = out.split(OMNI_CLIP_MARKER)
    assert.equal(head.length, Math.ceil((1000 - OMNI_CLIP_MARKER.length) * 0.65))
    assert.equal(tail.length, 1000 - OMNI_CLIP_MARKER.length - head.length)
  })

  it('不超长时原样返回', () => {
    assert.equal(clipSceneHeadTail('短', 10), '短')
  })

  it('超长 F 段：开头和结尾都在，末尾“这才像样”不丢，总长 ≤2500', () => {
    const start = '起始：晏无归立于断链之上，雨势转急。'
    const lastBeat = '最后一拍：他回身，衔接下一段殿门洞开。晏无归（音量骤降）：“这才像样。”'
    const scene = `${start}${'刀光与雷光交错，巨链寸寸崩断。'.repeat(400)}${lastBeat}`
    const p = buildOmniPrompt({
      sceneText: scene,
      cameraInstruction: 'dolly push forward',
      referenceNames: ['角色·晏无归', '斩龙钉', '宫殿'],
    })
    assert.ok(p.length <= KLING_OMNI_PROMPT_MAX, String(p.length))
    assert.ok(p.startsWith(start))
    const sceneOut = p.slice(0, p.indexOf('\n镜头：'))
    assert.ok(sceneOut.endsWith(lastBeat), sceneOut.slice(-80))
    assert.ok(sceneOut.includes(OMNI_CLIP_MARKER))
    assert.ok(p.includes('<<<image_3>>>为「宫殿」'))
    assert.ok(p.includes('逐字照读：晏无归（音量骤降）：“这才像样。”'))
  })
})

describe('修复4 · 零费用连通性检查（GET /account/costs）', () => {
  it('kling-omni 测试连接只调 /account/costs，带 Bearer API Key 和合理时间窗，不提交视频', async () => {
    const m = mockFetch(() => ({ code: 0, message: 'SUCCEED', data: {} }))
    restore = m.restore
    const now = 1_760_000_000_000
    const r = await testKlingOmniAccount({ ...provider, baseUrl: provider.baseUrl + '/' }, { now })
    assert.deepEqual(r, { ok: true })
    assert.equal(m.calls.length, 1)
    const call = m.calls[0]
    assert.equal(call.method, 'GET')
    const u = new URL(call.url)
    assert.equal(`${u.origin}${u.pathname}`, 'https://api-singapore.klingai.com/account/costs')
    assert.equal(u.searchParams.get('end_time'), String(now))
    assert.equal(u.searchParams.get('start_time'), String(now - 30 * 24 * 3600 * 1000))
    assert.equal(call.headers.Authorization, 'Bearer kling_xxx')
    assert.ok(!call.url.includes('omni-video'))
  })

  it('testProvider 对 kling-omni 走账户查询', async () => {
    const m = mockFetch(() => ({ code: 0 }))
    restore = m.restore
    const r = await testProvider({ ...provider, apiFlavor: 'kling-omni' })
    assert.equal(r.ok, true)
    assert.match(m.calls[0].url, /\/account\/costs\?/)
  })

  it('fetch 被浏览器拦截（TypeError）→ 明确 CORS 提示', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    restore = () => (globalThis.fetch = original)
    const r = await testKlingOmniAccount(provider)
    assert.deepEqual(r, { ok: false, error: KLING_CORS_ERROR })
    assert.equal(
      KLING_CORS_ERROR,
      'Kling 官方 API 当前无法从此浏览器 Origin 直连，请使用支持 CORS 的中转/后端代理。',
    )
  })

  it('HTTP 401 → 失败（API Key 无效）', async () => {
    const m = mockFetch(() => new Response('{"code":1004}', { status: 401 }))
    restore = m.restore
    const r = await testKlingOmniAccount(provider)
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
  })

  it('HTTP 200 + 业务 code≠0 → 失败', async () => {
    const m = mockFetch(() => ({ code: 1002, message: 'Authorization is invalid' }))
    restore = m.restore
    const r = await testKlingOmniAccount(provider)
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /1002/)
  })

  it('旧 kling image2video 测试连接行为不变：不发请求，只给 warning', async () => {
    const m = mockFetch(() => ({}))
    restore = m.restore
    const r = await testProvider({ ...provider, apiFlavor: 'kling' })
    assert.equal(r.ok, true)
    assert.match(r.warning ?? '', /没有标准的模型列表端点/)
    assert.equal(m.calls.length, 0)
  })
})
