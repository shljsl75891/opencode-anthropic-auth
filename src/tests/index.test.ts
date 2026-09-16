import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index'
import { readQuotaState } from '../quota-state'

type ModelCostTier = {
  input: number
  output: number
  cache: { read: number; write: number }
}
type FakeModel = { id: string; cost: ModelCostTier[] }

/**
 * Minimal mock of the OpenCode v2 promise plugin `Context`, covering only
 * the `integration`, `session`, and `model` surfaces this plugin uses.
 */
function createMockContext() {
  const integrationMethods: Array<Record<string, unknown>> = []
  const sessionHooks = new Map<string, (event: any) => Promise<void> | void>()
  const modelTransforms: Array<(editor: any) => void> = []
  let reloadCount = 0

  const ctx = {
    integration: {
      transform: mock(async (cb: (draft: any) => void) => {
        const draft = {
          method: {
            update: mock((input: Record<string, unknown>) => {
              integrationMethods.push(input)
            }),
          },
        }
        cb(draft)
        return { dispose: mock(async () => {}) }
      }),
      connection: {
        active: mock(
          async (_id: string): Promise<{ id: string } | undefined> => undefined,
        ),
        resolve: mock(
          async (_connection: unknown): Promise<unknown> => undefined,
        ),
      },
    },
    session: {
      hook: mock(
        async (name: string, cb: (event: any) => Promise<void> | void) => {
          sessionHooks.set(name, cb)
          return { dispose: mock(async () => {}) }
        },
      ),
    },
    model: {
      transform: mock(async (cb: (editor: any) => void) => {
        modelTransforms.push(cb)
        return { dispose: mock(async () => {}) }
      }),
      reload: mock(async () => {
        reloadCount++
      }),
    },
  }

  return {
    ctx,
    integrationMethods,
    sessionHooks,
    modelTransforms,
    getReloadCount: () => reloadCount,
  }
}

/** A mock context whose integration connection resolves an active Claude Pro/Max OAuth credential. */
function anthropicOAuthContext() {
  const mocked = createMockContext()
  ;(mocked.ctx.integration.connection.active as any).mockImplementation(
    async () => ({ id: 'conn-1' }),
  )
  ;(mocked.ctx.integration.connection.resolve as any).mockImplementation(
    async () => ({
      type: 'oauth',
      methodID: 'claude-max',
      refresh: 'r',
      access: 'my-access-token',
      expires: Date.now() + 100000,
    }),
  )
  return mocked
}

function createFakeModelEditor(models: FakeModel[]) {
  const byId = new Map(models.map((model) => [model.id, model]))
  return {
    list: (providerID?: string) =>
      providerID === 'anthropic' ? [...byId.values()] : [],
    update: (
      _providerID: string,
      modelID: string,
      updater: (model: FakeModel) => void,
    ) => {
      const model = byId.get(modelID)
      if (model) updater(model)
    },
  }
}

describe('default export', () => {
  test('is a v2 plugin definition with an id and a setup function', () => {
    expect(plugin.id).toBe('@sahiljassal/opencode-anthropic-auth')
    expect(plugin.setup).toBeFunction()
  })
})

describe('integration registration', () => {
  test('registers a Claude Pro/Max OAuth method on the anthropic integration', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    expect(integrationMethods).toHaveLength(1)
    const registration = integrationMethods[0]!
    expect(registration.integrationID).toBe('anthropic')
    expect(registration.method).toEqual({
      id: 'claude-max',
      type: 'oauth',
      label: 'Claude Pro/Max',
    })
    expect(registration.authorize).toBeFunction()
    expect(registration.refresh).toBeFunction()
  })

  test('authorize() returns a code-mode authorization pointing at claude.ai', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    const registration = integrationMethods[0] as any
    const authorization = await registration.authorize({})

    expect(authorization.mode).toBe('code')
    expect(authorization.instructions).toBeString()
    const url = new URL(authorization.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(authorization.callback).toBeFunction()
  })

  test('authorize callback exchanges a valid code for a Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'refresh-1',
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const authorization = await registration.authorize({})

      const credential = await authorization.callback(
        `somecode#${new URL(authorization.url).searchParams.get('state')}`,
      )

      expect(credential.type).toBe('oauth')
      expect(credential.methodID).toBe('claude-max')
      expect(credential.access).toBe('access-1')
      expect(credential.refresh).toBe('refresh-1')
      expect(credential.expires).toBeGreaterThan(Date.now())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('authorize callback throws on a failed exchange (invalid code)', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    const registration = integrationMethods[0] as any
    const authorization = await registration.authorize({})

    await expect(
      authorization.callback('not-a-valid-callback'),
    ).rejects.toThrow(/Failed to exchange/)
  })

  test('refresh() exchanges the refresh token for a rotated Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((_input: any, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.grant_type).toBe('refresh_token')
      expect(body.refresh_token).toBe('old-refresh')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any

      const rotated = await registration.refresh({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      expect(rotated).toEqual({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'new-refresh',
        access: 'new-access',
        expires: rotated.expires,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refresh() throws a descriptive error on failure', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Forbidden', { status: 403 })),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any

      await expect(
        registration.refresh({
          type: 'oauth',
          methodID: 'claude-max',
          refresh: 'old-refresh',
          access: 'old-access',
          expires: Date.now() - 1000,
        }),
      ).rejects.toThrow('Anthropic token refresh failed: 403')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('concurrent refresh() calls deduplicate to a single token request', async () => {
    const { ctx, integrationMethods } = createMockContext()

    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const results = await Promise.all(
        Array.from({ length: 5 }, () => registration.refresh(credential)),
      )

      expect(tokenRequests).toBe(1)
      for (const result of results) {
        expect(result.access).toBe('new-access')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('reuses a successful refresh for delayed calls with the rotated token', async () => {
    const { ctx, integrationMethods } = createMockContext()

    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    let expireCachedRefresh: (() => void) | undefined
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay: number,
    ) => {
      if (delay === 30_000) expireCachedRefresh = handler
      return { unref() {} }
    }) as unknown as typeof setTimeout)
    globalThis.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const first = await registration.refresh(credential)
      const delayed = await registration.refresh(credential)

      expect(tokenRequests).toBe(1)
      expect(delayed).toEqual(first)

      expireCachedRefresh?.()
      await registration.refresh(credential)
      expect(tokenRequests).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
      setTimeoutSpy.mockRestore()
    }
  })

  test('concurrent refreshes keep different credentials isolated', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refreshTokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const refreshToken = String(body.refresh_token)
      refreshTokens.push(refreshToken)
      return Promise.resolve(
        Response.json({
          refresh_token: `new-${refreshToken}`,
          access_token: `access-${refreshToken}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = (refresh: string) => ({
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      const [first, second] = await Promise.all([
        registration.refresh(credential('first')),
        registration.refresh(credential('second')),
      ])

      expect(refreshTokens.toSorted()).toEqual(['first', 'second'])
      expect(first.access).toBe('access-first')
      expect(second.access).toBe('access-second')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('model cost transform', () => {
  test('zeros cost for anthropic models when OAuth is active at setup', async () => {
    const { ctx, modelTransforms } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const models: FakeModel[] = [
      {
        id: 'claude-3',
        cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      },
    ]
    modelTransforms[0]!(createFakeModelEditor(models))

    expect(models[0]!.cost).toEqual([
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ])
  })

  test('leaves cost untouched when no OAuth connection is active', async () => {
    const { ctx, modelTransforms } = createMockContext()
    await plugin.setup(ctx as any)

    const models: FakeModel[] = [
      {
        id: 'claude-3',
        cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      },
    ]
    modelTransforms[0]!(createFakeModelEditor(models))

    expect(models[0]!.cost).toEqual([
      { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    ])
  })

  test('reloads models once an OAuth connection becomes active via a request', async () => {
    const { ctx, sessionHooks, getReloadCount } = createMockContext()
    await plugin.setup(ctx as any)

    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )

    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    }
    await sessionHooks.get('http.request')!(event)

    expect(getReloadCount()).toBe(1)
  })
})

describe('session http.request hook', () => {
  test('ignores non-anthropic providers', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request('https://api.openai.com/v1/chat', {
      method: 'POST',
      body: '{}',
    })
    const event: any = {
      model: { providerID: 'openai', id: 'gpt' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).toBe(originalRequest)
  })

  test('leaves API-key Anthropic requests untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: '{}' },
    )
    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).toBe(originalRequest)
  })

  test('rewrites headers, body, and URL for an active OAuth connection', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-length': String(body.length),
          'x-api-key': 'my-access-token',
        },
        body,
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).not.toBe(originalRequest)
    const rewritten: Request = event.request
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
    expect(rewritten.headers.get('x-api-key')).toBeNull()
    expect(rewritten.headers.get('content-length')).toBeNull()
    expect(rewritten.headers.get('anthropic-beta')).toContain(
      'oauth-2025-04-20',
    )
    expect(rewritten.url).toContain('beta=true')

    const parsedBody = JSON.parse(await rewritten.text())
    expect(parsedBody.tools[0].name).toBe('mcp_Bash')
    // Two-block layout: identity, rest (billing header removed in 1e03543)
    expect(parsedBody.system).toHaveLength(2)
    expect(parsedBody.system[0].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    )
    expect(parsedBody.system[1].text).toBe('You are a helpful assistant.')
    expect(parsedBody.messages[0].content[0].text).toBe(
      'hello world test message',
    )
  })

  test('preserves GET requests without a body', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'GET',
    })
    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(rewritten.method).toBe('GET')
    expect(await rewritten.text()).toBe('')
  })

  test('opts a recoverable-refusal model into server-side fallback', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-fable-5' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(rewritten.headers.get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    )
    const parsedBody = JSON.parse(await rewritten.text())
    expect(parsedBody.fallbacks).toBe('default')
  })

  test('does not opt an unrelated model into server-side fallback', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-sonnet-5' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(rewritten.headers.get('anthropic-beta')).not.toContain(
      'server-side-fallback-2026-07-01',
    )
    const parsedBody = JSON.parse(await rewritten.text())
    expect(parsedBody.fallbacks).toBeUndefined()
  })

  test('excludes interleaved-thinking beta for haiku models', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001' }),
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-haiku-4-5-20251001' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(rewritten.headers.get('anthropic-beta')).not.toContain(
      'interleaved-thinking-2025-05-14',
    )
  })
})

describe('session http.response hook', () => {
  async function setupOAuthRequestEvent(overrides?: {
    modelID?: string
    body?: string
  }) {
    const mocked = anthropicOAuthContext()
    await plugin.setup(mocked.ctx as any)

    const modelID = overrides?.modelID ?? 'claude-3'
    const requestEvent: any = {
      model: { providerID: 'anthropic', id: modelID },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body:
          overrides?.body ??
          JSON.stringify({
            model: modelID,
            messages: [{ role: 'user', content: 'hi' }],
          }),
      }),
    }
    await mocked.sessionHooks.get('http.request')!(requestEvent)
    return { ...mocked, requestEvent }
  }

  test('strips tool prefixes when the matching request used OAuth', async () => {
    const { sessionHooks, requestEvent } = await setupOAuthRequestEvent()

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
          ),
        )
        controller.close()
      },
    })
    const originalResponse = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const event: any = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).not.toBe(originalResponse)
    const text = await event.response.text()
    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('strips tool prefixes after another hook clones the OAuth request', async () => {
    const { sessionHooks, requestEvent } = await setupOAuthRequestEvent()
    const clonedRequest = new Request(requestEvent.request)

    const responseEvent: any = {
      model: requestEvent.model,
      request: clonedRequest,
      response: new Response(
        'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseEvent)

    expect(await responseEvent.response.text()).toContain('"name": "bash"')
  })

  test('leaves non-anthropic responses untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalResponse = new Response(null, { status: 200 })
    const event: any = {
      model: { providerID: 'openai', id: 'gpt' },
      request: new Request('https://api.openai.com/v1/chat'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).toBe(originalResponse)
  })

  test('leaves Anthropic responses untouched when the request did not use OAuth', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalResponse = new Response('ok')
    const event: any = {
      model: { providerID: 'anthropic', id: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).toBe(originalResponse)
  })

  test('hides a fallback content block in a streamed response for a recoverable-refusal model', async () => {
    const { sessionHooks, requestEvent } = await setupOAuthRequestEvent({
      modelID: 'claude-fable-5',
    })

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"claude-fable-5"},"to":{"model":"claude-opus-5"}}}\n\n',
          ),
        )
        controller.close()
      },
    })
    const event: any = {
      model: requestEvent.model,
      request: requestEvent.request,
      response: new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    }
    await sessionHooks.get('http.response')!(event)

    const text = await event.response.text()
    expect(text).not.toContain('"type":"fallback"')
    expect(text).toContain('\u2060')
  })

  describe('quota harvesting', () => {
    let quotaFile: string
    let originalEnv: string | undefined

    beforeEach(() => {
      quotaFile = join(mkdtempSync(join(tmpdir(), 'quota-test-')), 'quota.json')
      originalEnv = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE
      process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE = quotaFile
    })

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE = originalEnv
      }
    })

    test('writes quota state from response headers', async () => {
      const { sessionHooks, requestEvent } = await setupOAuthRequestEvent()
      const event: any = {
        model: requestEvent.model,
        request: requestEvent.request,
        response: new Response(null, {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.5',
            'anthropic-ratelimit-unified-5h-reset': '1893456000',
          },
        }),
      }
      await sessionHooks.get('http.response')!(event)

      expect(readQuotaState(quotaFile)?.fiveHour?.usedPercent).toBe(50)
    })

    test('does not throw when no quota headers are present', async () => {
      const { sessionHooks, requestEvent } = await setupOAuthRequestEvent()
      const event: any = {
        model: requestEvent.model,
        request: requestEvent.request,
        response: new Response(null, { status: 200 }),
      }
      await sessionHooks.get('http.response')!(event)

      expect(readQuotaState(quotaFile)).toBeUndefined()
    })

    test('serves the response even when quota headers are malformed', async () => {
      const { sessionHooks, requestEvent } = await setupOAuthRequestEvent()
      const event: any = {
        model: requestEvent.model,
        request: requestEvent.request,
        response: new Response(null, {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.5',
            'anthropic-ratelimit-unified-5h-reset': '1e308',
          },
        }),
      }

      expect(() => sessionHooks.get('http.response')!(event)).not.toThrow()
    })
  })
})
