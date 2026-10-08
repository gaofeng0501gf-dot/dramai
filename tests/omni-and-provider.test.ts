import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  KLING_OMNI_MAX_REFS,
  buildOmniCandidates,
  buildOmniPrompt,
  dedupeAssetIds,
  isShotVideoReady,
  resolveOmniReferenceBlobs,
  toOmniDuration,
  validateOmniReferenceIds,
} from '@/core/video/omni'
import {
  API_FLAVOR_LABEL,
  FLAVOR_DEFAULTS,
  flavorsForKind,
  toProviderDraft,
} from '@/components/settings/provider-draft'
import type { Provider } from '@/types/domain'
import { pngBlob } from './helpers'

describe('kling-omni Provider 保存', () => {
  const values = {
    label: 'Kling Omni 官方',
    kind: 'image2video' as const,
    baseUrl: ' https://api-singapore.klingai.com ',
    apiKey: ' ak:sk ',
    model: 'kling-v3-omni',
    notes: '',
    apiFlavor: 'kling-omni' as const,
  }

  it('表单 → 草稿保留 apiFlavor=kling-omni，并能经 JSON（zustand persist）往返', () => {
    const draft = toProviderDraft(values)
    assert.deepEqual(draft, {
      label: 'Kling Omni 官方',
      kind: 'image2video',
      baseUrl: 'https://api-singapore.klingai.com',
      apiKey: 'ak:sk',
      model: 'kling-v3-omni',
      notes: undefined,
      apiFlavor: 'kling-omni',
    })
    const stored: Provider = JSON.parse(JSON.stringify({ id: 'x', ...draft }))
    assert.equal(stored.apiFlavor, 'kling-omni')
  })

  it('协议下拉：图生视频同时有 Kling image2video 与 Kling Omni；文生图里没有 Omni', () => {
    const i2v = flavorsForKind('image2video')
    assert.ok(i2v.includes('kling'))
    assert.ok(i2v.includes('kling-omni'))
    assert.ok(
      i2v.includes('openai-compatible') &&
        i2v.includes('volcengine') &&
        i2v.includes('aliyun') &&
        i2v.includes('runway'),
    )
    assert.deepEqual(flavorsForKind('text2image'), ['openai-compatible', 'gemini'])
    assert.match(API_FLAVOR_LABEL['kling-omni'], /POST \/v1\/videos\/omni-video/)
    assert.match(API_FLAVOR_LABEL.kling, /POST \/v1\/videos\/image2video/)
  })

  it('Kling Omni 默认 Base URL / 模型', () => {
    assert.deepEqual(FLAVOR_DEFAULTS['kling-omni'], {
      baseUrl: 'https://api-singapore.klingai.com',
      model: 'kling-v3-omni',
    })
  })
})

describe('Omni 就绪判断', () => {
  const omni = { apiFlavor: 'kling-omni' as const }
  const kling = { apiFlavor: 'kling' as const }

  it('kling-omni 不需要 imageAssetId，只看 referenceAssetIds', () => {
    assert.equal(isShotVideoReady({ referenceAssetIds: ['a'] }, omni), true)
    assert.equal(isShotVideoReady({ imageAssetId: 'img' }, omni), false)
    assert.equal(isShotVideoReady({ imageAssetId: 'img', referenceAssetIds: [] }, omni), false)
  })

  it('普通 image2video 仍以 imageAssetId 判断', () => {
    assert.equal(isShotVideoReady({ imageAssetId: 'img' }, kling), true)
    assert.equal(isShotVideoReady({ referenceAssetIds: ['a'] }, kling), false)
    assert.equal(isShotVideoReady({ imageAssetId: 'img' }, { apiFlavor: undefined }), true)
  })
})

describe('Omni 参考素材校验', () => {
  it('去重保序', () => {
    assert.deepEqual(dedupeAssetIds(['a', 'b', 'a', '', undefined, 'c', 'b']), ['a', 'b', 'c'])
  })

  it('为空禁止；最多 7 个；去重后再计数', () => {
    assert.deepEqual(validateOmniReferenceIds(undefined), {
      ok: false,
      error: '请先选择 Omni 参考素材',
    })
    assert.deepEqual(validateOmniReferenceIds([]), { ok: false, error: '请先选择 Omni 参考素材' })
    const seven = Array.from({ length: 7 }, (_, i) => `a${i}`)
    assert.deepEqual(validateOmniReferenceIds(seven), { ok: true, ids: seven })
    const eight = [...seven, 'a7']
    const r = validateOmniReferenceIds(eight)
    assert.equal(r.ok, false)
    assert.equal(KLING_OMNI_MAX_REFS, 7)
    assert.deepEqual(validateOmniReferenceIds([...seven, 'a0', 'a1']), { ok: true, ids: seven })
  })

  it('referenceAssetIds → Blob 列表（按 id 顺序，复用已有 Blob，带名称）', async () => {
    const blobs = new Map([
      ['hero', pngBlob('hero')],
      ['blade', pngBlob('blade')],
    ])
    const r = await resolveOmniReferenceBlobs(
      ['blade', 'hero', 'blade'],
      async (id) => (blobs.has(id) ? { blob: blobs.get(id)!, kind: 'image' } : undefined),
      (id) => ({ hero: '角色·晏无归', blade: '斩龙钉' })[id],
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.refs.length, 2)
    assert.equal(r.refs[0].blob, blobs.get('blade'))
    assert.equal(r.refs[0].name, '斩龙钉')
    assert.equal(r.refs[1].name, '角色·晏无归')
  })

  it('非图片 asset 拒绝', async () => {
    const r = await resolveOmniReferenceBlobs(['v'], async () => ({
      blob: pngBlob('v'),
      kind: 'video',
    }))
    assert.equal(r.ok, false)
  })
})

describe('Omni 选择器候选', () => {
  it('A 绑定+锁定角色参考图，B 项目 image 素材；按 assetId 去重', () => {
    const list = buildOmniCandidates(
      { characterIds: ['c1', 'c2', 'c3'] },
      [
        { id: 'c1', name: '晏无归', locked: true, referenceAssetId: 'hero' },
        { id: 'c2', name: '未锁定', locked: false, referenceAssetId: 'x' },
        { id: 'c3', name: '无图', locked: true },
        { id: 'c4', name: '不在本镜', locked: true, referenceAssetId: 'other' },
      ],
      [
        { kind: 'image', name: '斩龙钉', assetId: 'blade' },
        { kind: 'image', name: '主角原图', assetId: 'hero' },
        { kind: 'doc', name: '剧本.docx', assetId: 'doc' },
        { kind: 'image', name: '无 asset' },
      ],
    )
    assert.deepEqual(list, [
      { assetId: 'hero', label: '角色·晏无归', source: 'character' },
      { assetId: 'blade', label: '斩龙钉', source: 'material' },
    ])
  })
})

describe('Omni prompt', () => {
  it('以 sceneText 为主体，含运镜、<<<image_N>>> 参考说明与一致性约束，不含 imagePrompt', () => {
    const p = buildOmniPrompt({
      sceneText: '晏无归收刀。晏无归：“这才像样。”',
      cameraInstruction: 'dolly push forward',
      referenceNames: ['角色·晏无归', undefined],
    })
    assert.ok(p.startsWith('晏无归收刀。晏无归：“这才像样。”'))
    assert.ok(p.includes('镜头：dolly push forward'))
    assert.ok(p.includes('<<<image_1>>>为「角色·晏无归」；<<<image_2>>>'))
    assert.ok(p.includes('保留原生环境声'))
  })

  it('超长 sceneText 被截断，但参考说明仍在且总长 ≤2500', () => {
    const p = buildOmniPrompt({ sceneText: '动'.repeat(5000), referenceNames: ['a'] })
    assert.ok(p.length <= 2500)
    assert.ok(p.includes('<<<image_1>>>'))
  })

  it('duration 夹到 3~15 的字符串', () => {
    assert.equal(toOmniDuration(undefined), '5')
    assert.equal(toOmniDuration(1), '3')
    assert.equal(toOmniDuration(10.4), '10')
    assert.equal(toOmniDuration(99), '15')
  })
})
