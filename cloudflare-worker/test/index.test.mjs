// dramai-kling-proxy 本地纯逻辑测试：node --test cloudflare-worker/test
// 上游 fetch 全部注入为假实现，不会访问网络，也不会产生任何 Kling 费用。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_ORIGIN, UPSTREAM, allowedMethodFor, handleRequest } from '../src/index.js'

const WORKER = 'https://dramai-kling-proxy.example.workers.dev'
// 测试用假值，不是真实凭据
const env = { KLING_API_KEY: 'test-upstream-key-DO-NOT-LEAK', PROXY_TOKEN: 'test-proxy-token' }

function req(
  path,
  { method = 'GET', origin = ALLOWED_ORIGIN, token = env.PROXY_TOKEN, body, headers = {} } = {},
) {
  const h = new Headers(headers)
  if (origin) h.set('Origin', origin)
  if (token !== null) h.set('Authorization', `Bearer ${token}`)
  if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  return new Request(`${WORKER}${path}`, { method, headers: h, body })
}

function fakeUpstream(
  respond = () =>
    new Response('{"code":0}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
) {
  const calls = []
  const fetchImpl = async (url, init) => {
    // 模拟上游消费 ReadableStream；仅测试端收集字节用于逐字比较。
    const body = init.body === undefined ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer())
    calls.push({ url, method: init.method, headers: new Headers(init.headers), body, rawBody: init.body })
    return respond(url, init)
  }
  return { calls, fetchImpl }
}

async function allText(res) {
  const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')
  return `${headers}\n${await res.text()}`
}

describe('Origin', () => {
  it('1. GitHub Pages Origin 放行，响应带 CORS 头', async () => {
    const up = fakeUpstream()
    const res = await handleRequest(
      req('/account/costs?start_time=1&end_time=2'),
      env,
      up.fetchImpl,
    )
    assert.equal(res.status, 200)
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      'https://gaofeng0501gf-dot.github.io',
    )
    assert.equal(res.headers.get('Vary'), 'Origin')
    assert.equal(up.calls.length, 1)
  })

  it('2. 其他 Origin / 无 Origin 返回 403，且不访问上游', async () => {
    const up = fakeUpstream()
    for (const origin of [
      'https://evil.example',
      'https://gaofeng0501gf-dot.github.io.evil.com',
      'http://gaofeng0501gf-dot.github.io',
      null,
    ]) {
      const res = await handleRequest(req('/account/costs', { origin }), env, up.fetchImpl)
      assert.equal(res.status, 403, String(origin))
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
    }
    assert.equal(up.calls.length, 0)
  })
})

describe('鉴权', () => {
  it('固定使用已验证的 Beijing 上游', () => {
    assert.equal(UPSTREAM, 'https://api-beijing.klingai.com')
  })

  it('3. 错误 / 缺失 PROXY_TOKEN 返回 401，且不访问上游', async () => {
    const up = fakeUpstream()
    for (const token of ['wrong', `${env.PROXY_TOKEN}x`, '', env.KLING_API_KEY, null]) {
      const res = await handleRequest(req('/account/costs', { token }), env, up.fetchImpl)
      assert.equal(res.status, 401, String(token))
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
    }
    // 大小写或前缀不同也不行
    const r = await handleRequest(
      req('/account/costs', {
        token: null,
        headers: { Authorization: `bearer ${env.PROXY_TOKEN}` },
      }),
      env,
      up.fetchImpl,
    )
    assert.equal(r.status, 401)
    assert.equal(up.calls.length, 0)
  })

  it('8. 上游 Authorization 使用 KLING_API_KEY，而不是 PROXY_TOKEN，并清理复制空白', async () => {
    const up = fakeUpstream()
    const spacedEnv = { ...env, KLING_API_KEY: `  ${env.KLING_API_KEY}  \n` }
    await handleRequest(req('/account/costs?start_time=1&end_time=2'), spacedEnv, up.fetchImpl)
    assert.equal(up.calls[0].headers.get('Authorization'), `Bearer ${env.KLING_API_KEY}`)
    assert.ok(!up.calls[0].headers.get('Authorization').includes(env.PROXY_TOKEN))
  })

  it('Secret 未配置时返回 500，不访问上游', async () => {
    const up = fakeUpstream()
    const res = await handleRequest(req('/account/costs'), { PROXY_TOKEN: 'x' }, up.fetchImpl)
    assert.equal(res.status, 500)
    assert.equal(up.calls.length, 0)
  })
})

describe('路径白名单', () => {
  it('4. 未允许的路径 / 方法返回 404，且不访问上游', async () => {
    const up = fakeUpstream()
    const cases = [
      ['/v1/videos/image2video', 'POST'],
      ['/v1/videos/text2video', 'POST'],
      ['/v1/images/generations', 'POST'],
      ['/account/costs/extra', 'GET'],
      ['/v1/videos/omni-video/abc/def', 'GET'],
      ['/v1/videos/omni-video/..%2F..%2Faccount', 'GET'],
      ['/', 'GET'],
      ['/account/costs', 'POST'],
      ['/v1/videos/omni-video', 'GET'],
      ['/v1/videos/omni-video/123', 'POST'],
      ['/v1/videos/omni-video/123', 'DELETE'],
    ]
    for (const [path, method] of cases) {
      const body = method === 'POST' ? '{}' : undefined
      const res = await handleRequest(req(path, { method, body }), env, up.fetchImpl)
      assert.equal(res.status, 404, `${method} ${path}`)
    }
    assert.equal(up.calls.length, 0)
  })

  it('白名单只有三个接口', () => {
    assert.equal(allowedMethodFor('/account/costs'), 'GET')
    assert.equal(allowedMethodFor('/v1/videos/omni-video'), 'POST')
    assert.equal(allowedMethodFor('/v1/videos/omni-video/859123456789'), 'GET')
    assert.equal(allowedMethodFor('/v1/videos/image2video'), null)
  })
})

describe('CORS 预检', () => {
  it('5. OPTIONS 返回 204 与正确 CORS 头，不需要 token，不访问上游', async () => {
    const up = fakeUpstream()
    for (const path of ['/account/costs', '/v1/videos/omni-video', '/v1/videos/omni-video/123']) {
      const res = await handleRequest(
        req(path, { method: 'OPTIONS', token: null }),
        env,
        up.fetchImpl,
      )
      assert.equal(res.status, 204, path)
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
      assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET,POST,OPTIONS')
      assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Authorization,Content-Type')
      assert.equal(res.headers.get('Vary'), 'Origin')
    }
    const bad = await handleRequest(
      req('/account/costs', { method: 'OPTIONS', origin: 'https://evil.example', token: null }),
      env,
      up.fetchImpl,
    )
    assert.equal(bad.status, 403)
    const unknown = await handleRequest(
      req('/nope', { method: 'OPTIONS', token: null }),
      env,
      up.fetchImpl,
    )
    assert.equal(unknown.status, 404)
    assert.equal(up.calls.length, 0)
  })
})

describe('转发', () => {
  it('6. /account/costs 原样转发 query 到固定上游', async () => {
    const up = fakeUpstream()
    await handleRequest(
      req(
        '/account/costs?start_time=1757000000000&end_time=1759592000000&resource_pack_name=a%20b',
      ),
      env,
      up.fetchImpl,
    )
    assert.equal(
      up.calls[0].url,
      `${UPSTREAM}/account/costs?start_time=1757000000000&end_time=1759592000000&resource_pack_name=a%20b`,
    )
    assert.equal(up.calls[0].method, 'GET')
    assert.equal(up.calls[0].body, undefined)
  })

  it('7. Omni POST body 逐字节不变，Content-Type 保留，不转发 Host / Content-Length / Cookie', async () => {
    const up = fakeUpstream(
      () =>
        new Response('{"code":0,"data":{"task_id":"T1"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const body = JSON.stringify({
      model_name: 'kling-v3-omni',
      prompt: '晏无归收刀。晏无归：“这才像样。”',
      image_list: [{ image_url: 'aGVsbG8=' }],
      mode: 'pro',
      aspect_ratio: '16:9',
      duration: '5',
      sound: 'on',
    })
    const res = await handleRequest(
      req('/v1/videos/omni-video', {
        method: 'POST',
        body,
        headers: { Cookie: 'a=b', 'Content-Type': 'application/json; charset=utf-8' },
      }),
      env,
      up.fetchImpl,
    )
    assert.equal(res.status, 200)
    const call = up.calls[0]
    assert.equal(call.url, `${UPSTREAM}/v1/videos/omni-video`)
    assert.equal(call.method, 'POST')
    assert.deepEqual(call.body, new TextEncoder().encode(body))
    assert.ok(call.rawBody instanceof ReadableStream, 'POST 必须流式转发，不能变成 ArrayBuffer')
    assert.equal(call.headers.get('Content-Type'), 'application/json; charset=utf-8')
    assert.equal(call.headers.get('Host'), null)
    assert.equal(call.headers.get('Content-Length'), null)
    assert.equal(call.headers.get('Cookie'), null)
    assert.equal(call.headers.get('Origin'), null)
    assert.equal(await res.text(), '{"code":0,"data":{"task_id":"T1"}}')
  })

  it('流式透传原始 body，不调用 request.arrayBuffer', async () => {
    const input = req('/v1/videos/omni-video', { method: 'POST', body: 'x'.repeat(256 * 1024) })
    input.arrayBuffer = () => { throw new Error('arrayBuffer() forbidden') }
    const up = fakeUpstream()
    const res = await handleRequest(input, env, up.fetchImpl)
    assert.equal(res.status, 200)
    assert.equal(up.calls[0].body.length, 256 * 1024)
    assert.ok(up.calls[0].rawBody instanceof ReadableStream)
  })

  it('轮询 GET /v1/videos/omni-video/{task_id} 转发到上游同一路径', async () => {
    const up = fakeUpstream()
    await handleRequest(req('/v1/videos/omni-video/859123456789'), env, up.fetchImpl)
    assert.equal(up.calls[0].url, `${UPSTREAM}/v1/videos/omni-video/859123456789`)
  })

  it('Kling 的 HTTP 状态码与响应体原样返回（含错误）', async () => {
    const up = fakeUpstream(
      () =>
        new Response('{"code":1102,"message":"balance"}', {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const res = await handleRequest(
      req('/account/costs?start_time=1&end_time=2'),
      env,
      up.fetchImpl,
    )
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('Content-Type'), 'application/json')
    assert.equal(await res.text(), '{"code":1102,"message":"balance"}')
  })

  it('上游不可达返回 502', async () => {
    const res = await handleRequest(req('/account/costs'), env, async () => {
      throw new TypeError('network')
    })
    assert.equal(res.status, 502)
  })
})

describe('Secret 不外泄', () => {
  it('9. 任何响应（成功 / 403 / 401 / 404 / 预检 / 502）都不含 KLING_API_KEY；上游杂项头不透传', async () => {
    const up = fakeUpstream(
      () =>
        new Response('{"code":0}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'sid=1',
            'X-Debug-Auth': `Bearer ${env.KLING_API_KEY}`,
          },
        }),
    )
    const responses = [
      await handleRequest(req('/account/costs?start_time=1&end_time=2'), env, up.fetchImpl),
      await handleRequest(
        req('/v1/videos/omni-video', { method: 'POST', body: '{}' }),
        env,
        up.fetchImpl,
      ),
      await handleRequest(
        req('/account/costs', { origin: 'https://evil.example' }),
        env,
        up.fetchImpl,
      ),
      await handleRequest(req('/account/costs', { token: 'wrong' }), env, up.fetchImpl),
      await handleRequest(req('/nope'), env, up.fetchImpl),
      await handleRequest(
        req('/account/costs', { method: 'OPTIONS', token: null }),
        env,
        up.fetchImpl,
      ),
      await handleRequest(req('/account/costs'), env, async () => {
        throw new Error(env.KLING_API_KEY)
      }),
    ]
    for (const res of responses) {
      const all = await allText(res)
      assert.ok(!all.includes(env.KLING_API_KEY), all)
      assert.equal(res.headers.get('Set-Cookie'), null)
      assert.equal(res.headers.get('X-Debug-Auth'), null)
    }
  })

  it('阶段日志不泄露 API Key、代理口令、prompt 或图片', async () => {
    const logs = []
    const oldInfo = console.info
    console.info = (value) => logs.push(String(value))
    try {
      const up = fakeUpstream()
      await handleRequest(req('/v1/videos/omni-video', {
        method: 'POST', body: JSON.stringify({ prompt: 'PRIVATE_PROMPT', image_list: [{ image_url: 'PRIVATE_IMAGE' }] }),
      }), env, up.fetchImpl)
    } finally {
      console.info = oldInfo
    }
    assert.deepEqual(logs.map((line) => JSON.parse(line).stage), ['forward_start', 'upstream_headers'])
    const all = logs.join(' ')
    for (const forbidden of [env.KLING_API_KEY, env.PROXY_TOKEN, 'PRIVATE_PROMPT', 'PRIVATE_IMAGE']) {
      assert.ok(!all.includes(forbidden))
    }
  })})
