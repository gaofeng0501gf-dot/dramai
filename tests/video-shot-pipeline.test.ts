import { afterEach, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { Asset, Character, Material, Provider, Storyboard } from '@/types/domain'
import type { VideoShotEvent } from '@/core/pipeline/video-shot'
import { b64, installFileReaderShim, mockFetch, pngBlob, type RecordedCall } from './helpers'

/**
 * 真跑 generateShotVideo：用 node:test 的 module mock 把 Dexie 存储层换成内存表，
 * 其它（omni 纯逻辑、factory、Kling 客户端、下载、写回）都是真代码。
 */

const src = (p: string) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href

const assets = new Map<string, Asset>()
const storyboards = new Map<string, Storyboard>()
const characters: Character[] = []
const materials: Material[] = []
let assetSeq = 0

const table = <T>(rows: () => T[]) => ({
  where: () => ({
    equals: (v: string) => ({
      toArray: async () => rows().filter((r) => (r as { projectId: string }).projectId === v),
    }),
  }),
})

mock.module(src('core/storage/db.ts'), {
  namedExports: {
    db: {
      assets: { get: async (id: string) => assets.get(id) },
      characters: table(() => characters),
      materials: table(() => materials),
    },
  },
})
mock.module(src('core/storage/assets.ts'), {
  namedExports: {
    createAsset: async (input: Omit<Asset, 'id' | 'createdAt'>) => {
      const a = { ...input, id: `new-${++assetSeq}`, createdAt: 0 } as Asset
      assets.set(a.id, a)
      return a
    },
    deleteAsset: async (id: string) => void assets.delete(id),
  },
})
mock.module(src('core/storage/storyboards.ts'), {
  namedExports: {
    updateStoryboard: async (id: string, patch: Partial<Storyboard>) => {
      const s = storyboards.get(id)
      if (s) storyboards.set(id, { ...s, ...patch })
    },
  },
})

const { generateShotVideo } = await import('@/core/pipeline/video-shot')

const omniProvider: Provider = {
  id: 'omni',
  label: 'Kling Omni',
  kind: 'image2video',
  apiFlavor: 'kling-omni',
  baseUrl: 'https://api-singapore.klingai.com',
  apiKey: 'k',
  model: 'kling-v3-omni',
}
const klingProvider: Provider = {
  ...omniProvider,
  id: 'kling',
  apiFlavor: 'kling',
  model: 'kling-v2',
}

function addImage(id: string): void {
  assets.set(id, {
    id,
    projectId: 'p1',
    kind: 'image',
    mimeType: 'image/png',
    blob: pngBlob(id),
    createdAt: 0,
  })
}

function shot(patch: Partial<Storyboard> = {}): Storyboard {
  const s: Storyboard = {
    id: 's1',
    projectId: 'p1',
    sequence: 6,
    sceneText: '雷雨宫灯下，晏无归踏碎巨链，回身收刀。晏无归：“这才像样。”',
    imagePrompt: 'STATIC KEYFRAME PROMPT, hero standing still',
    characterIds: ['c1'],
    durationSec: 5,
    status: 'pending',
    ...patch,
  }
  storyboards.set(s.id, s)
  return s
}

async function run(provider: Provider, sb: Storyboard) {
  const events: VideoShotEvent[] = []
  for await (const ev of generateShotVideo({
    provider,
    storyboard: sb,
    pollIntervalMs: 1,
    timeoutSec: 5,
  })) {
    events.push(ev)
  }
  return events
}

function klingServer(call: RecordedCall) {
  if (call.url.endsWith('.mp4')) return new Response(new Blob(['mp4'], { type: 'video/mp4' }))
  if (call.method === 'POST') return { code: 0, data: { task_id: 'T1' } }
  return {
    code: 0,
    data: {
      task_status: 'succeed',
      task_result: { videos: [{ url: 'https://cdn/x.mp4', duration: 5 }] },
    },
  }
}

let restore: (() => void) | undefined
before(() => {
  installFileReaderShim()
  characters.push({
    id: 'c1',
    projectId: 'p1',
    name: '晏无归',
    role: 'protagonist',
    referenceAssetId: 'hero',
    locked: true,
    createdAt: 0,
  })
  materials.push({
    id: 'm1',
    projectId: 'p1',
    kind: 'image',
    name: '斩龙钉',
    text: '',
    assetId: 'blade',
    createdAt: 0,
  })
  addImage('hero')
  addImage('blade')
})
afterEach(() => {
  restore?.()
  restore = undefined
})

describe('generateShotVideo · kling-omni', () => {
  it('不需要 imageAssetId：用 referenceAssetIds 直接出视频，并写回 videoAssetId', async () => {
    const m = mockFetch(klingServer)
    restore = m.restore
    const sb = shot({ imageAssetId: undefined, referenceAssetIds: ['hero', 'blade', 'hero'] })
    const events = await run(omniProvider, sb)

    assert.equal(events.at(-1)?.phase, 'done', JSON.stringify(events))
    const submit = m.calls.find((c) => c.method === 'POST')!
    assert.equal(submit.url, 'https://api-singapore.klingai.com/v1/videos/omni-video')
    const body = submit.body as Record<string, unknown>
    // 去重后 2 张，顺序保持
    assert.deepEqual(body.image_list, [
      { image_url: b64('fake-png-hero') },
      { image_url: b64('fake-png-blade') },
    ])
    assert.equal(body.sound, 'on')
    assert.equal(body.model_name, 'kling-v3-omni')
    // prompt 以 sceneText 为主体，不用静态 imagePrompt；对白原样保留
    const prompt = body.prompt as string
    assert.ok(prompt.startsWith(sb.sceneText), prompt)
    assert.ok(prompt.includes('晏无归：“这才像样。”'))
    assert.ok(!prompt.includes('STATIC KEYFRAME PROMPT'))
    assert.ok(prompt.includes('<<<image_1>>>为「角色·晏无归」'))
    assert.ok(prompt.includes('<<<image_2>>>为「斩龙钉」'))

    assert.ok(
      m.calls.some((c) => c.url === 'https://api-singapore.klingai.com/v1/videos/omni-video/T1'),
    )
    const saved = storyboards.get('s1')!
    assert.equal(saved.status, 'video-ready')
    assert.ok(saved.videoAssetId && assets.get(saved.videoAssetId)?.kind === 'video')
    // 参考素材本身未被复制或删除
    assert.ok(assets.has('hero') && assets.has('blade'))
  })

  it('没有 referenceAssetIds 时报错且不提交', async () => {
    const m = mockFetch(klingServer)
    restore = m.restore
    const events = await run(
      omniProvider,
      shot({ imageAssetId: 'hero', referenceAssetIds: undefined }),
    )
    assert.deepEqual(events, [{ shotId: 's1', phase: 'error', message: '请先选择 Omni 参考素材' }])
    assert.equal(m.calls.length, 0)
  })

  it('超过 7 个参考素材时报错且不提交', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `r${i}`)
    ids.forEach(addImage)
    const m = mockFetch(klingServer)
    restore = m.restore
    const events = await run(omniProvider, shot({ referenceAssetIds: ids }))
    assert.equal(events.length, 1)
    assert.equal(events[0].phase, 'error')
    assert.match(events[0].message ?? '', /最多 7 个/)
    assert.equal(m.calls.length, 0)
  })

  it('参考 asset 已被删除时报错且不提交', async () => {
    const m = mockFetch(klingServer)
    restore = m.restore
    const events = await run(omniProvider, shot({ referenceAssetIds: ['hero', 'gone'] }))
    assert.equal(events[0].phase, 'error')
    assert.match(events[0].message ?? '', /缺失/)
    assert.equal(m.calls.length, 0)
  })
})

describe('generateShotVideo · 普通 Kling image2video 不回归', () => {
  it('仍然要求 imageAssetId', async () => {
    const m = mockFetch(klingServer)
    restore = m.restore
    const events = await run(
      klingProvider,
      shot({ imageAssetId: undefined, referenceAssetIds: ['hero'] }),
    )
    assert.deepEqual(events, [
      { shotId: 's1', phase: 'error', message: '该分镜还没有起始图（先生图再生视频）' },
    ])
    assert.equal(m.calls.length, 0)
  })

  it('有起始图时仍走 /v1/videos/image2video，prompt = imagePrompt + sceneText', async () => {
    addImage('frame')
    const m = mockFetch(klingServer)
    restore = m.restore
    const sb = shot({ imageAssetId: 'frame', referenceAssetIds: ['hero'] })
    const events = await run(klingProvider, sb)
    assert.equal(events.at(-1)?.phase, 'done')
    const submit = m.calls.find((c) => c.method === 'POST')!
    assert.equal(submit.url, 'https://api-singapore.klingai.com/v1/videos/image2video')
    const body = submit.body as Record<string, unknown>
    assert.equal(body.image, b64('fake-png-frame'))
    assert.equal(body.prompt, `${sb.imagePrompt}. ${sb.sceneText}. static camera, no movement`)
    assert.equal('image_list' in body, false)
  })
})
