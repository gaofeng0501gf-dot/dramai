import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { showImageGenerationEntry, storyboardStatusLabel } from '@/core/video/omni'
import type { ApiFlavor, Storyboard } from '@/types/domain'

const omni = { apiFlavor: 'kling-omni' as ApiFlavor }
const normals: Array<{ apiFlavor?: ApiFlavor } | undefined> = [
  { apiFlavor: 'kling' },
  { apiFlavor: 'openai-compatible' },
  { apiFlavor: 'volcengine' },
  { apiFlavor: 'aliyun' },
  { apiFlavor: 'runway' },
  { apiFlavor: undefined },
  undefined,
]

describe('Omni 模式隐藏旧生图入口', () => {
  it('kling-omni：不显示批量生图 / 单镜生图入口', () => {
    assert.equal(showImageGenerationEntry(omni), false)
  })

  it('普通模式（含未配置视频 provider）：仍显示', () => {
    for (const p of normals) assert.equal(showImageGenerationEntry(p), true, JSON.stringify(p))
  })

  // 组件依赖浏览器 / IndexedDB，这里校验接线：两个入口都由 showImageGenerationEntry 控制
  const src = (f: string) => readFileSync(path.resolve(import.meta.dirname, '../src', f), 'utf8')

  it('ProjectDetail：BatchImageButton 受开关控制，BatchVideoButton 不受影响', () => {
    const s = src('pages/ProjectDetail.tsx')
    assert.match(s, /showImageGenerationEntry\(useActiveProvider\('image2video'\)\)/)
    assert.match(s, /\{showImageEntry && <BatchImageButton projectId=\{project\.id\} \/>\}/)
    assert.equal((s.match(/<BatchImageButton /g) ?? []).length, 1)
    assert.match(s, /^\s*<BatchVideoButton projectId=\{project\.id\} \/>$/m)
  })

  it('StoryboardList：ShotImageButton 受开关控制，Omni参考 / 生视频照常显示', () => {
    const s = src('components/storyboard/StoryboardList.tsx')
    assert.match(s, /showImageGenerationEntry\(videoProvider\)/)
    assert.match(s, /\{showImageEntry && <ShotImageButton shot=\{s\} \/>\}/)
    assert.equal((s.match(/<ShotImageButton /g) ?? []).length, 1)
    assert.match(s, /^\s*<OmniReferencePicker shot=\{s\} \/>$/m)
    assert.match(s, /^\s*<ShotVideoButton shot=\{s\} \/>$/m)
    assert.match(s, /storyboardStatusLabel\(s, videoProvider\)/)
  })
})

describe('分镜状态文案', () => {
  const shot = (p: Partial<Storyboard>) =>
    ({ status: 'pending', ...p }) as Pick<
      Storyboard,
      'status' | 'videoAssetId' | 'referenceAssetIds'
    >

  it('Omni：待选参考 → 待生视频 → 视频已生成', () => {
    assert.equal(storyboardStatusLabel(shot({}), omni), '待选参考')
    assert.equal(storyboardStatusLabel(shot({ referenceAssetIds: [] }), omni), '待选参考')
    // 旧数据里即使有起始图，Omni 下也以参考素材为准
    assert.equal(storyboardStatusLabel(shot({ status: 'image-ready' }), omni), '待选参考')
    assert.equal(storyboardStatusLabel(shot({ referenceAssetIds: ['a'] }), omni), '待生视频')
    assert.equal(
      storyboardStatusLabel(shot({ status: 'image-ready', referenceAssetIds: ['a'] }), omni),
      '待生视频',
    )
    assert.equal(
      storyboardStatusLabel(
        shot({ status: 'video-ready', videoAssetId: 'v', referenceAssetIds: ['a'] }),
        omni,
      ),
      '视频已生成',
    )
  })

  it('普通模式：仍是 待生图 / 图已生成 / 视频已生成 / 失败', () => {
    for (const p of normals) {
      assert.equal(storyboardStatusLabel(shot({ referenceAssetIds: ['a'] }), p), '待生图')
      assert.equal(storyboardStatusLabel(shot({ status: 'image-ready' }), p), '图已生成')
      assert.equal(
        storyboardStatusLabel(shot({ status: 'video-ready', videoAssetId: 'v' }), p),
        '视频已生成',
      )
      assert.equal(storyboardStatusLabel(shot({ status: 'failed' }), p), '失败')
    }
  })
})
