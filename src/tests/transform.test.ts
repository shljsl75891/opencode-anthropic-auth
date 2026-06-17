import { afterEach, describe, expect, test } from 'bun:test'
import dedent from 'dedent'
import {
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  REQUIRED_BETAS,
} from '../constants'
import {
  createStrippedStream,
  isInsecure,
  mergeBetaHeaders,
  mergeHeaders,
  prefixToolNames,
  prependClaudeCodeIdentity,
  type RetryableAnthropicStreamError,
  rewriteRequestBody,
  rewriteUrl,
  sanitizeSystemText,
  setOAuthHeaders,
  stripToolPrefix,
} from '../transform'

const CACHE_1H = { type: 'ephemeral', ttl: '1h' }

describe('mergeHeaders', () => {
  test('copies headers from a Request object', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-custom': 'value' },
    })
    const headers = mergeHeaders(request)
    expect(headers.get('x-custom')).toBe('value')
  })

  test('copies headers from init Headers object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: new Headers({ 'x-init': 'from-headers' }),
    })
    expect(headers.get('x-init')).toBe('from-headers')
  })

  test('copies headers from init array', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: [['x-arr', 'from-array']],
    })
    expect(headers.get('x-arr')).toBe('from-array')
  })

  test('copies headers from init plain object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: { 'x-obj': 'from-object' },
    })
    expect(headers.get('x-obj')).toBe('from-object')
  })

  test('init headers override Request headers', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-key': 'from-request' },
    })
    const headers = mergeHeaders(request, {
      headers: { 'x-key': 'from-init' },
    })
    expect(headers.get('x-key')).toBe('from-init')
  })

  test('handles string input without init', () => {
    const headers = mergeHeaders('https://example.com')
    expect([...headers.entries()]).toHaveLength(0)
  })

  test('handles URL input', () => {
    const headers = mergeHeaders(new URL('https://example.com'))
    expect([...headers.entries()]).toHaveLength(0)
  })
})

describe('mergeBetaHeaders', () => {
  test('includes required betas when no incoming betas', () => {
    const headers = new Headers()
    const result = mergeBetaHeaders(headers)
    expect(result).toBe(REQUIRED_BETAS.join(','))
  })

  test('merges incoming betas with required betas', () => {
    const headers = new Headers({ 'anthropic-beta': 'custom-beta-1' })
    const result = mergeBetaHeaders(headers)

    for (const beta of REQUIRED_BETAS) {
      expect(result).toContain(beta)
    }
    expect(result).toContain('custom-beta-1')
  })

  test('deduplicates betas', () => {
    const beta = REQUIRED_BETAS[0] ?? ''
    const headers = new Headers({
      'anthropic-beta': beta,
    })
    const result = mergeBetaHeaders(headers)
    const parts = result.split(',')
    const occurrences = parts.filter((p) => p === REQUIRED_BETAS[0])
    expect(occurrences).toHaveLength(1)
  })

  test('handles comma-separated incoming betas', () => {
    const headers = new Headers({
      'anthropic-beta': 'beta-a, beta-b',
    })
    const result = mergeBetaHeaders(headers)
    expect(result).toContain('beta-a')
    expect(result).toContain('beta-b')
  })
})

describe('setOAuthHeaders', () => {
  test('sets authorization bearer token', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'my-token')
    expect(headers.get('authorization')).toBe('Bearer my-token')
  })

  test('sets user-agent', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('user-agent')).toContain('claude-cli')
  })

  test('removes x-api-key', () => {
    const headers = new Headers({ 'x-api-key': 'sk-ant-xxx' })
    setOAuthHeaders(headers, 'token')
    expect(headers.get('x-api-key')).toBeNull()
  })

  test('sets anthropic-beta header', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('anthropic-beta')).toBeString()
    for (const beta of REQUIRED_BETAS) {
      expect(headers.get('anthropic-beta')).toContain(beta)
    }
  })
})

describe('prefixToolNames', () => {
  test('prefixes tool definition names', () => {
    const body = {
      tools: [
        { name: 'read_file', type: 'function' },
        { name: 'write_file', type: 'function' },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBe('mcp_Read_file')
    expect(result.tools[1].name).toBe('mcp_Write_file')
  })

  test('prefixes tool_use block names in messages', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: '1' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0].name).toBe('mcp_Bash')
    expect(result.messages[0].content[1].type).toBe('text')
  })

  test('does not prefix non-tool_use blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'hello',
    })
  })

  test('handles missing tools and messages gracefully', () => {
    const body = { model: 'claude-3' }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.model).toBe('claude-3')
  })

  test('handles tools without names', () => {
    const body = {
      tools: [{ type: 'function' }],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBeUndefined()
  })
})

describe('stripToolPrefix', () => {
  test('strips mcp_ prefix from tool names', () => {
    const text = '{"name": "mcp_read_file"}'
    expect(stripToolPrefix(text)).toBe('{"name": "read_file"}')
  })

  test('strips multiple prefixed names', () => {
    const text = '{"name": "mcp_tool_a"} and {"name": "mcp_tool_b"}'
    const result = stripToolPrefix(text)
    expect(result).toContain('"name": "tool_a"')
    expect(result).toContain('"name": "tool_b"')
  })

  test('does not strip names without mcp_ prefix', () => {
    const text = '{"name": "regular_tool"}'
    expect(stripToolPrefix(text)).toBe(text)
  })

  test('handles whitespace variations in JSON', () => {
    const text = '{"name"  :  "mcp_tool"}'
    expect(stripToolPrefix(text)).toBe('{"name": "tool"}')
  })
})

describe('rewriteUrl', () => {
  const originalEnv = process.env.ANTHROPIC_BASE_URL

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_BASE_URL
    } else {
      process.env.ANTHROPIC_BASE_URL = originalEnv
    }
  })

  test('adds beta=true to /v1/messages URL string', () => {
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('adds beta=true to /v1/messages URL object', () => {
    const { input } = rewriteUrl(
      new URL('https://api.anthropic.com/v1/messages'),
    )
    const url = input instanceof URL ? input : new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('adds beta=true to /v1/messages Request', () => {
    const request = new Request('https://api.anthropic.com/v1/messages')
    const { input } = rewriteUrl(request)
    const url = new URL((input as Request).url)
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('does not modify URL if beta param already exists', () => {
    const original = 'https://api.anthropic.com/v1/messages?beta=false'
    const { input } = rewriteUrl(original)
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('false')
  })

  test('does not modify non-/v1/messages URLs', () => {
    const original = 'https://api.anthropic.com/v1/complete'
    const { input } = rewriteUrl(original)
    const url = new URL(input.toString())
    expect(url.searchParams.has('beta')).toBe(false)
  })

  test('overrides origin when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
  })

  test('preserves beta=true when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('preserves existing query params when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl(
      'https://api.anthropic.com/v1/messages?foo=bar',
    )
    const url = new URL(input.toString())
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.searchParams.get('foo')).toBe('bar')
  })

  test('handles ANTHROPIC_BASE_URL with trailing slash', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080/'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.pathname).toBe('/v1/messages')
    expect(url.origin).toBe('http://localhost:8080')
  })

  test('ignores invalid ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'not-a-url'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('ignores empty ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = ''
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('rejects file: scheme in ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'file:///etc/passwd'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('rejects ANTHROPIC_BASE_URL with embedded credentials', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://user:pass@localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('returns original input when no URL changes are needed', () => {
    const original = 'https://api.anthropic.com/v1/complete'
    const { input } = rewriteUrl(original)
    expect(input).toBe(original)
  })

  test('returns original Request when no URL changes are needed', () => {
    const request = new Request('https://api.anthropic.com/v1/complete')
    const { input } = rewriteUrl(request)
    expect(input).toBe(request)
  })

  test('overrides origin for Request input when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const request = new Request('https://api.anthropic.com/v1/messages')
    const { input } = rewriteUrl(request)
    const url = new URL((input as Request).url)
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
  })
})

describe('isInsecure', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
  const originalInsecure = process.env.ANTHROPIC_INSECURE

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL
    } else {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl
    }
    if (originalInsecure === undefined) {
      delete process.env.ANTHROPIC_INSECURE
    } else {
      process.env.ANTHROPIC_INSECURE = originalInsecure
    }
  })

  test('returns false when neither env var is set', () => {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_INSECURE
    expect(isInsecure()).toBe(false)
  })

  test('returns false when only ANTHROPIC_INSECURE is set (no base URL)', () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_INSECURE = '1'
    expect(isInsecure()).toBe(false)
  })

  test('returns false when ANTHROPIC_BASE_URL is set but ANTHROPIC_INSECURE is not', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    delete process.env.ANTHROPIC_INSECURE
    expect(isInsecure()).toBe(false)
  })

  test('returns true when both are set and ANTHROPIC_INSECURE is "1"', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = '1'
    expect(isInsecure()).toBe(true)
  })

  test('returns true when ANTHROPIC_INSECURE is "true"', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = 'true'
    expect(isInsecure()).toBe(true)
  })

  test('returns false for other ANTHROPIC_INSECURE values', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = 'yes'
    expect(isInsecure()).toBe(false)
  })
})

describe('createStrippedStream', () => {
  test('strips tool prefixes from streamed response body', async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read"}}\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })

    const original = new Response(stream, { status: 200 })
    const stripped = createStrippedStream(original)

    const text = await stripped.text()
    expect(text).toContain('"name": "bash"')
    expect(text).toContain('"name": "read"')
    expect(text).not.toContain('mcp_bash')
    expect(text).not.toContain('mcp_read')
  })

  test('preserves response status and headers', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })

    const original = new Response(stream, {
      status: 201,
      statusText: 'Created',
      headers: { 'x-custom': 'value' },
    })

    const stripped = createStrippedStream(original)
    expect(stripped.status).toBe(201)
    expect(stripped.headers.get('x-custom')).toBe('value')
  })

  test('returns original response if no body', () => {
    const original = new Response(null, { status: 204 })
    const result = createStrippedStream(original)
    expect(result).toBe(original)
  })
})

describe('sanitizeSystemText', () => {
  // Anchor-based sanitization. Three mechanisms:
  //
  //   1. The OPENCODE_IDENTITY line is always removed.
  //   2. Any paragraph containing a PARAGRAPH_REMOVAL_ANCHORS entry
  //      (e.g. "github.com/anomalyco/opencode", "opencode.ai/docs")
  //      is removed entirely.
  //   3. TEXT_REPLACEMENTS are applied inline for short branded strings
  //      inside paragraphs we want to keep (e.g. "if OpenCode honestly"
  //      → "if the assistant honestly").
  //
  // Everything else — generic instructions, tone/style, task management,
  // tool policy, environment info, skills, user instructions, file paths
  // containing "opencode", etc. — is preserved.

  test('returns text unchanged when OpenCode identity not present', () => {
    const text = 'Just a normal system prompt'
    expect(sanitizeSystemText(text)).toBe(text)
  })

  test('removes identity, keeps generic content', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      You have access to tools for reading files.

      Instructions from: ~/.config/opencode/preamble.md
      Be concise. Prefer TypeScript.

      # Code References
      src/index.ts (1-50)
    `)
    expect(result).toMatchInlineSnapshot(`
      "You have access to tools for reading files.

      Instructions from: ~/.config/opencode/preamble.md
      Be concise. Prefer TypeScript.

      # Code References
      src/index.ts (1-50)"
    `)
  })

  test('removes paragraph containing feedback URL anchor', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Report issues at https://github.com/anomalyco/opencode please.

      Generic instructions that stay.
    `)
    expect(result).toMatchInlineSnapshot(`"Generic instructions that stay."`)
  })

  test('removes paragraph containing docs URL anchor', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Check out the docs at https://opencode.ai/docs for more info.

      Other content preserved.
    `)
    expect(result).toMatchInlineSnapshot(`"Other content preserved."`)
  })

  test('applies inline text replacement', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      It is best if OpenCode honestly applies rigorous standards.
    `)
    expect(result).toMatchInlineSnapshot(
      `"It is best if the assistant honestly applies rigorous standards."`,
    )
  })

  test('rewrites the "useful information about the environment" fingerprint', () => {
    // Anthropic's classifier matches this exact phrase as a third-party-agent
    // signal; leaving it intact produces a 400 invalid_request_error disguised
    // as "You're out of extra usage." The TEXT_REPLACEMENTS entry rewrites it
    // in place so the env-block context still reaches the model.
    const result = sanitizeSystemText(dedent`
      Here is some useful information about the environment you are running in:
      <env>
        Working directory: /tmp/project
      </env>
    `)
    expect(result).toMatchInlineSnapshot(`
      "Environment context you are running in:
      <env>
        Working directory: /tmp/project
      </env>"
    `)
  })

  test('preserves "opencode" in file paths and unrelated content', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Instructions from: /Users/user/project/.opencode/AGENTS.md
      Run opencode to start the CLI.
    `)
    expect(result).toMatchInlineSnapshot(`
      "Instructions from: /Users/user/project/.opencode/AGENTS.md
      Run opencode to start the CLI."
    `)
  })

  test('preserves content before and after identity', () => {
    const result = sanitizeSystemText(dedent`
      Some prefix content

      You are OpenCode, the best coding agent on the planet.

      # Code References
      file contents
    `)
    expect(result).toMatchInlineSnapshot(`
      "Some prefix content

      # Code References
      file contents"
    `)
  })
})

describe('prependClaudeCodeIdentity', () => {
  test('returns identity block for undefined system', () => {
    const result = prependClaudeCodeIdentity(undefined)
    expect(result).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('sanitizes and prepends for string system', () => {
    const result = prependClaudeCodeIdentity('Some assistant prompt')
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).toBe('Some assistant prompt')
  })

  test('sanitizes array of text blocks', () => {
    const system = [
      {
        type: 'text',
        text: `${OPENCODE_IDENTITY_PREFIX}\nstuff\n\n# Code References\nrest`,
      },
      { type: 'text', text: 'other block' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result[1]?.text).toContain('# Code References')
  })

  test('does not double-prepend if identity already present', () => {
    const system = [
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'other' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('handles string elements in array', () => {
    const system = ['some text', 'more text']
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]).toEqual({ type: 'text', text: 'some text' })
  })
})

describe('rewriteRequestBody', () => {
  test('prefixes tool names and rewrites system prompt', () => {
    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.tools[0].name).toBe('mcp_Bash')
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('You are a helpful assistant.')
  })

  test('handles missing system field', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('returns original string on invalid JSON', () => {
    const body = 'not valid json'
    expect(rewriteRequestBody(body)).toBe(body)
  })

  test('rewrites realistic OpenCode request end-to-end', () => {
    const systemPrompt = [
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'You have access to tools.',
      '',
      '# Code References',
      '',
      'Here are some files.',
    ].join('\n')

    const body = JSON.stringify({
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read_file', type: 'function' },
      ],
      messages: [
        { role: 'user', content: 'Help me fix this bug' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: 'tool_1' },
            { type: 'text', text: 'Let me check' },
          ],
        },
        { role: 'user', content: 'What did you find?' },
      ],
      system: [
        { type: 'text', text: systemPrompt },
        { type: 'text', text: 'Additional context block' },
      ],
    })

    const result = JSON.parse(rewriteRequestBody(body))

    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toContain('You have access to tools.')
    expect(result.system[1].text).toContain('# Code References')
    expect(result.system[1].text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result.system[2].text).toBe('Additional context block')

    expect(result.messages[0].content[0].text).toBe('Help me fix this bug')
    expect(result.messages[1].content[0].name).toBe('mcp_Bash')
  })

  test('handles body with no messages array', () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('keeps system blocks in system[] (string content)', () => {
    const body = JSON.stringify({
      system: 'Custom instructions for the assistant.',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Custom instructions for the assistant.')
    expect(result.messages[0].content[0].text).toBe('hello')
  })

  test('keeps system blocks in system[] (array content)', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'Block A instructions' },
        { type: 'text', text: 'Block B instructions' },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Block A instructions')
    expect(result.system[2].text).toBe('Block B instructions')

    expect(result.messages[0].content).toHaveLength(1)
    expect(result.messages[0].content[0].text).toBe('hello')
  })

  test('keeps system intact when no user messages exist', () => {
    const body = JSON.stringify({
      system: 'Some instructions',
      messages: [],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Some instructions')
  })

  test('coalesces plugin-added tail blocks beyond primary system prompt', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
        { type: 'text', text: 'Third block' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('First block')
    expect(result.system[2].text).toBe('Second block\nThird block')
    expect(result.messages[0].content[0].text).toBe('hi')
  })

  test('preserves client context_management field untouched', () => {
    const contextManagement = {
      edits: [
        {
          type: 'clear_tool_uses_20250919',
          trigger: { input_tokens: 40000 },
          keep: { tool_uses: 5 },
        },
      ],
    }
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      context_management: contextManagement,
    })
    const result = JSON.parse(rewriteRequestBody(body))

    expect(result.context_management).toEqual(contextManagement)
  })
})

import { REALISTIC_SYSTEM_PROMPT } from './fixtures/realistic-system-prompt'

describe('sanitizeSystemText – realistic prompt', () => {
  test('sanitizeSystemText output snapshot', () => {
    const result = sanitizeSystemText(REALISTIC_SYSTEM_PROMPT)
    expect(result).toMatchSnapshot()
  })

  test('rewriteRequestBody output snapshot', () => {
    const body = JSON.stringify({
      system: REALISTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read', type: 'function' },
        { name: 'edit', type: 'function' },
      ],
    })
    const result = rewriteRequestBody(body)
    expect(JSON.parse(result)).toMatchSnapshot()
  })
})

function makeMsg(
  role: string,
  content: string | Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { role, content }
}

function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

function cacheBody(opts: { system?: unknown; messages: unknown[] }): string {
  return JSON.stringify({
    system: opts.system ?? 'Instructions.',
    messages: opts.messages,
  })
}

describe('hybrid cache – breakpoint placement', () => {
  test('strips all existing cache_control before placing new ones', () => {
    const raw = JSON.stringify({
      system: [
        { type: 'text', text: 'block', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi', cacheControl: { type: 'ephemeral' } },
          ],
        },
      ],
    })
    const result = JSON.parse(rewriteRequestBody(raw))
    const ccs: unknown[] = []
    for (const block of result.system) {
      if (block.cache_control) ccs.push(block.cache_control)
    }
    for (const cc of ccs) {
      expect(cc).toMatchObject({ ttl: '1h' })
    }
  })

  test('anchors last system block (after identity) with 1h cache', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          system: [
            { type: 'text', text: 'Block A' },
            { type: 'text', text: 'Block B' },
          ],
          messages: [makeMsg('user', 'hello')],
        }),
      ),
    )
    expect(result.system[2].cache_control).toEqual(CACHE_1H)
    expect(result.system[1].cache_control).toBeUndefined()
    expect(result.system[0].cache_control).toBeUndefined()
  })

  test('does not anchor system block when only identity is present', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({ system: undefined, messages: [makeMsg('user', 'hello')] }),
      ),
    )
    expect(result.system[0].cache_control).toBeUndefined()
  })

  test('anchors last cacheable block of messages[0]', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [makeMsg('user', [textBlock('only block')])],
        }),
      ),
    )
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
  })

  test('anchors last cacheable block of messages[1] (normal path)', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', 'msg0'),
            makeMsg('user', [textBlock('msg1 block')]),
          ],
        }),
      ),
    )
    expect(result.messages[1].content[0].cache_control).toEqual(CACHE_1H)
  })

  test('skips thinking blocks when placing cache anchor', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', [
              { type: 'thinking', thinking: 'some reasoning' },
              textBlock('actual content'),
            ]),
          ],
        }),
      ),
    )
    expect(result.messages[0].content[1].cache_control).toEqual(CACHE_1H)
    expect(result.messages[0].content[0].cache_control).toBeUndefined()
  })

  test('skips redacted_thinking blocks when placing cache anchor', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', [
              { type: 'redacted_thinking', data: 'opaque' },
              textBlock('real content'),
            ]),
          ],
        }),
      ),
    )
    expect(result.messages[0].content[1].cache_control).toEqual(CACHE_1H)
    expect(result.messages[0].content[0].cache_control).toBeUndefined()
  })

  test('skips message entirely when all blocks are thinking (no cache_control set)', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', [{ type: 'thinking', thinking: 'reasoning only' }]),
          ],
        }),
      ),
    )
    expect(result.messages[0].cache_control).toBeUndefined()
    expect(result.messages[0].content[0].cache_control).toBeUndefined()
  })

  test('magic-context split: anchors block[0] and block[1] of messages[0] when it has ≥2 cacheable blocks', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', [
              textBlock('stable prefix A'),
              textBlock('stable prefix B'),
              textBlock('volatile delta'),
            ]),
          ],
        }),
      ),
    )
    const content = result.messages[0].content
    expect(content[0].cache_control).toEqual(CACHE_1H)
    expect(content[1].cache_control).toEqual(CACHE_1H)
    expect(content[2].cache_control).toBeUndefined()
  })

  test('rolling latest anchor: anchors the latest user message beyond index 1', () => {
    const messages = [
      makeMsg('user', 'msg0'),
      makeMsg('user', 'msg1'),
      makeMsg('assistant', [{ type: 'text', text: 'response' }]),
      makeMsg('user', 'msg3 – latest'),
    ]
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))
    const msg3content = result.messages[3].content
    expect(Array.isArray(msg3content)).toBe(true)
    expect(msg3content[0].cache_control).toEqual(CACHE_1H)
  })

  test('bridge anchor: placed when rolling distance exceeds 20-block lookback', () => {
    const messages: unknown[] = [
      makeMsg('user', 'msg0'),
      makeMsg('user', 'msg1'),
    ]
    for (let i = 2; i < 30; i++) {
      messages.push(makeMsg('user', `msg${i}`))
    }
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))

    // With 28 rolling user messages (index 2-29), bridge lands at index 8
    // (cumulative blocks from index 9 to 29 = 21 > 20) and latest is index 29.
    const latestContent = result.messages[29].content
    expect(Array.isArray(latestContent)).toBe(true)
    expect(latestContent[0].cache_control).toEqual(CACHE_1H)

    // Some earlier message must carry the bridge anchor
    const bridgeAnchored = result.messages
      .slice(2, 29)
      .some((msg: Record<string, unknown>) => {
        const content = Array.isArray(msg.content) ? msg.content : []
        return (content as Array<Record<string, unknown>>).some(
          (block) => block.cache_control != null,
        )
      })
    expect(bridgeAnchored).toBe(true)
  })

  test('magic-context + bridge: bridge always placed regardless of msg0 layout', () => {
    // msg0 has ≥2 cacheable blocks (magic-context), plus enough messages for a bridge
    const messages: unknown[] = [
      makeMsg('user', [
        textBlock('stable prefix A'),
        textBlock('stable prefix B'),
        textBlock('volatile delta'),
      ]),
      makeMsg('user', 'msg1'),
    ]
    for (let i = 2; i < 30; i++) {
      messages.push(makeMsg('user', `msg${i}`))
    }
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))

    // msg0: block[0] and block[1] anchored (magic-context split)
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
    expect(result.messages[0].content[1].cache_control).toEqual(CACHE_1H)
    expect(result.messages[0].content[2].cache_control).toBeUndefined()

    // Bridge must be anchored in the rolling range (not msg0 or latest)
    const bridgeAnchored = result.messages
      .slice(2, 29)
      .some((msg: Record<string, unknown>) => {
        const content = Array.isArray(msg.content) ? msg.content : []
        return (content as Array<Record<string, unknown>>).some(
          (block) => block.cache_control != null,
        )
      })
    expect(bridgeAnchored).toBe(true)

    // Latest (msg29) must also be anchored
    const latestContent = result.messages[29].content
    expect(Array.isArray(latestContent)).toBe(true)
    expect(latestContent[0].cache_control).toEqual(CACHE_1H)
  })

  test('trailing assistant messages are stripped before caching', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', 'question'),
            makeMsg('assistant', 'answer'),
          ],
        }),
      ),
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
  })

  test('multiple trailing assistant messages all stripped', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', 'q'),
            makeMsg('assistant', 'a1'),
            makeMsg('assistant', 'a2'),
          ],
        }),
      ),
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
  })

  test('does not strip non-trailing assistant messages', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', 'q1'),
            makeMsg('assistant', 'a1'),
            makeMsg('user', 'q2'),
          ],
        }),
      ),
    )
    expect(result.messages).toHaveLength(3)
  })

  test('string message content normalised to block array for cache anchor', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [makeMsg('user', 'plain string content')],
        }),
      ),
    )
    expect(Array.isArray(result.messages[0].content)).toBe(true)
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
  })

  test('empty text block is not used as cache anchor', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', [
              { type: 'text', text: 'real content' },
              { type: 'text', text: '' },
            ]),
          ],
        }),
      ),
    )
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
    expect(result.messages[0].content[1].cache_control).toBeUndefined()
  })

  test('whitespace-only text block is not used as cache anchor', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', [
              { type: 'text', text: 'real content' },
              { type: 'text', text: '   \n  ' },
            ]),
          ],
        }),
      ),
    )
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
    expect(result.messages[0].content[1].cache_control).toBeUndefined()
  })

  test('non-empty text block still anchored normally', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [makeMsg('user', [{ type: 'text', text: 'has content' }])],
        }),
      ),
    )
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
  })

  test('message with only empty text blocks gets no cache anchor', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', [{ type: 'text', text: '' }]),
            makeMsg('user', 'real message'),
          ],
        }),
      ),
    )
    expect(result.messages[0].content[0].cache_control).toBeUndefined()
    expect(result.messages[1].content[0].cache_control).toEqual(CACHE_1H)
  })

  test('tool_result-only user message is anchored on its last block', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        cacheBody({
          messages: [
            makeMsg('user', 'run the tool'),
            makeMsg('assistant', [
              { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            ]),
            makeMsg('user', [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'output line 1',
              },
              {
                type: 'tool_result',
                tool_use_id: 't2',
                content: 'output line 2',
              },
            ]),
          ],
        }),
      ),
    )
    const content = result.messages[2].content
    expect(content[content.length - 1].cache_control).toEqual(CACHE_1H)
  })

  test('bridge fires when assistant turns push positional distance past lookback', () => {
    // Layout: [user m0, user m1, (assistant×5, user)×6]
    // Rolling user indices: 3,5,7,9,11,13. latestIndex=13.
    // Walking back from 13: cum reaches 23 at i=6 (5 blocks) with lastAnchor=7.
    // Bridge lands at index 7; indices 3,5,9,11 are not anchored.
    const messages: unknown[] = [makeMsg('user', 'm0'), makeMsg('user', 'm1')]
    for (let i = 0; i < 6; i++) {
      messages.push(
        makeMsg('assistant', [
          textBlock('a1'),
          textBlock('a2'),
          textBlock('a3'),
          textBlock('a4'),
          textBlock('a5'),
        ]),
      )
      messages.push(makeMsg('user', `q${i}`))
    }
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))

    const latestContent = result.messages[13].content
    expect(latestContent[latestContent.length - 1].cache_control).toEqual(
      CACHE_1H,
    )

    const bridgeContent = result.messages[7].content
    expect(bridgeContent[bridgeContent.length - 1].cache_control).toEqual(
      CACHE_1H,
    )

    for (const idx of [3, 5, 9, 11]) {
      const msg = result.messages[idx] as Record<string, unknown>
      const content = Array.isArray(msg.content) ? msg.content : []
      const anchored = (content as Array<Record<string, unknown>>).some(
        (b) => b.cache_control != null,
      )
      expect(anchored).toBe(false)
    }
  })

  test('bridge not placed when no valid user anchor exists before overflow', () => {
    // messages[2] is the only rolling anchor between m1 and latest, but a
    // 25-block assistant turn separates them — overflow fires before any anchor
    // is set, so bridge=undefined and messages[1] takes the normal slot-3 anchor.
    const messages = [
      makeMsg('user', 'm0'),
      makeMsg('user', 'm1'),
      makeMsg('user', 'mid'),
      makeMsg(
        'assistant',
        Array.from({ length: 25 }, (_, i) => textBlock(`a${i}`)),
      ),
      makeMsg('user', 'latest'),
    ]
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))

    // bridge=undefined → messages[1] anchored in the normal msg[1] slot
    const msg1 = result.messages[1]
    expect(Array.isArray(msg1.content)).toBe(true)
    expect(msg1.content[msg1.content.length - 1].cache_control).toEqual(
      CACHE_1H,
    )

    // 'mid' (index 2) carries no bridge anchor
    const midContent = Array.isArray(result.messages[2].content)
      ? (result.messages[2].content as Array<Record<string, unknown>>)
      : []
    expect(midContent.some((b) => b.cache_control != null)).toBe(false)
  })

  test('bridge placed when block distance equals lookback threshold', () => {
    // Exactly 20 blocks between bridge candidate (index 2) and latest (index 4).
    // cumBlocks at anchor check = 20, which is not > 20, so bridge IS placed.
    const messages = [
      makeMsg('user', 'm0'),
      makeMsg('user', 'm1'),
      makeMsg('user', 'bridge-candidate'),
      makeMsg(
        'assistant',
        Array.from({ length: 20 }, (_, i) => textBlock(`a${i}`)),
      ),
      makeMsg('user', 'latest'),
    ]
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))

    const bridgeContent = result.messages[2].content
    expect(
      (bridgeContent as Array<Record<string, unknown>>).some(
        (b) => b.cache_control != null,
      ),
    ).toBe(true)
  })

  test('bridge not placed when block distance exceeds lookback threshold by one', () => {
    // 21 blocks between bridge candidate (index 2) and latest (index 4).
    // cumBlocks at anchor check = 21 > 20 → bridge=undefined.
    const messages = [
      makeMsg('user', 'm0'),
      makeMsg('user', 'm1'),
      makeMsg('user', 'bridge-candidate'),
      makeMsg(
        'assistant',
        Array.from({ length: 21 }, (_, i) => textBlock(`a${i}`)),
      ),
      makeMsg('user', 'latest'),
    ]
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))

    // bridge=undefined → messages[1] takes the normal msg[1] slot
    const msg1 = result.messages[1]
    expect(Array.isArray(msg1.content)).toBe(true)
    expect(msg1.content[msg1.content.length - 1].cache_control).toEqual(
      CACHE_1H,
    )
  })

  test('no bridge when only one rolling anchor exists (latestIndex === 2)', () => {
    // Only messages[2] qualifies as a rolling anchor (index > 1).
    // The loop has no valid bridge candidate → bridge=undefined.
    const messages = [
      makeMsg('user', 'm0'),
      makeMsg('user', 'm1'),
      makeMsg('user', 'latest'),
    ]
    const result = JSON.parse(rewriteRequestBody(cacheBody({ messages })))

    // latest at index 2 is anchored
    expect(result.messages[2].content[0].cache_control).toEqual(CACHE_1H)
    // bridge=undefined → messages[1] anchored in the normal msg[1] slot
    expect(result.messages[1].content[0].cache_control).toEqual(CACHE_1H)
  })
})

describe('coalesceHybridSystemTail – system block merging', () => {
  function coalescebody(
    system: unknown,
    messages: unknown[] = [{ role: 'user', content: 'hi' }],
  ): string {
    return JSON.stringify({ system, messages })
  }

  test('does not coalesce when only one block follows identity + primary prompt', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        coalescebody([
          { type: 'text', text: 'Primary instructions' },
          { type: 'text', text: 'Plugin block' },
        ]),
      ),
    )
    expect(result.system).toHaveLength(3)
    expect(result.system[1].text).toBe('Primary instructions')
    expect(result.system[2].text).toBe('Plugin block')
  })

  test('does not coalesce when only identity and primary prompt exist', () => {
    const result = JSON.parse(
      rewriteRequestBody(coalescebody([{ type: 'text', text: 'Only block' }])),
    )
    expect(result.system).toHaveLength(2)
    expect(result.system[1].text).toBe('Only block')
  })

  test('merges two plugin blocks into one after primary prompt', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        coalescebody([
          { type: 'text', text: 'Primary' },
          { type: 'text', text: 'Plugin A' },
          { type: 'text', text: 'Plugin B' },
        ]),
      ),
    )
    expect(result.system).toHaveLength(3)
    expect(result.system[1].text).toBe('Primary')
    expect(result.system[2].text).toBe('Plugin A\nPlugin B')
  })

  test('merges three plugin blocks into one', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        coalescebody([
          { type: 'text', text: 'Primary' },
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' },
          { type: 'text', text: 'C' },
        ]),
      ),
    )
    expect(result.system).toHaveLength(3)
    expect(result.system[2].text).toBe('A\nB\nC')
  })

  test('cache anchor lands on merged tail block', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        coalescebody([
          { type: 'text', text: 'Primary' },
          { type: 'text', text: 'Plugin A' },
          { type: 'text', text: 'Plugin B' },
        ]),
      ),
    )
    expect(result.system[result.system.length - 1].cache_control).toEqual(
      CACHE_1H,
    )
    expect(result.system[0].cache_control).toBeUndefined()
    expect(result.system[1].cache_control).toBeUndefined()
  })
})

function makeStream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

describe('createStrippedStream – SSE retryable errors', () => {
  test('throws RetryableAnthropicStreamError on api_error event', async () => {
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Internal error"}}\n\n'
    const stripped = createStrippedStream(makeStream([errorEvent]))

    let caught: unknown
    try {
      await stripped.text()
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    const err = caught as RetryableAnthropicStreamError
    expect(err.code).toBe('ECONNRESET')
    expect(err.syscall).toBe('anthropic-sse')
    expect(err.providerErrorType).toBe('api_error')
  })

  test('throws on overloaded_error event', async () => {
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    const stripped = createStrippedStream(makeStream([errorEvent]))

    let caught: unknown
    try {
      await stripped.text()
    } catch (e) {
      caught = e
    }

    const err = caught as RetryableAnthropicStreamError
    expect(err.code).toBe('ECONNRESET')
    expect(err.providerErrorType).toBe('overloaded_error')
  })

  test('throws on server_error type', async () => {
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"server_error","message":"Server error"}}\n\n'
    const stripped = createStrippedStream(makeStream([errorEvent]))

    let caught: unknown
    try {
      await stripped.text()
    } catch (e) {
      caught = e
    }

    const err = caught as RetryableAnthropicStreamError
    expect(err.code).toBe('ECONNRESET')
    expect(err.providerErrorType).toBe('server_error')
  })

  test('throws on "server overloaded" message text', async () => {
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"unknown","message":"server overloaded"}}\n\n'
    const stripped = createStrippedStream(makeStream([errorEvent]))

    let caught: unknown
    try {
      await stripped.text()
    } catch (e) {
      caught = e
    }

    const err = caught as RetryableAnthropicStreamError
    expect(err.code).toBe('ECONNRESET')
  })

  test('does not throw for normal content events', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const stripped = createStrippedStream(makeStream(chunks))
    const text = await stripped.text()
    expect(text).toContain('message_start')
  })

  test('does not throw for non-retryable error type', async () => {
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"Invalid key"}}\n\n'
    const stripped = createStrippedStream(makeStream([errorEvent]))
    const text = await stripped.text()
    expect(text).toContain('authentication_error')
  })

  test('throws when error event is split across two stream chunks', async () => {
    const fullEvent =
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"oops"}}\n\n'
    const mid = Math.floor(fullEvent.length / 2)
    const chunks = [fullEvent.slice(0, mid), fullEvent.slice(mid)]

    const stripped = createStrippedStream(makeStream(chunks))

    let caught: unknown
    try {
      await stripped.text()
    } catch (e) {
      caught = e
    }

    const err = caught as RetryableAnthropicStreamError
    expect(err.code).toBe('ECONNRESET')
    expect(err.syscall).toBe('anthropic-sse')
  })

  test('throws when retryable error event lacks trailing boundary', async () => {
    // Some servers omit the final \n\n — the pending buffer must be flushed on done.
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"no-boundary"}}'
    const stripped = createStrippedStream(makeStream([errorEvent]))

    let caught: unknown
    try {
      await stripped.text()
    } catch (e) {
      caught = e
    }

    const err = caught as RetryableAnthropicStreamError
    expect(err.code).toBe('ECONNRESET')
    expect(err.providerErrorType).toBe('api_error')
  })
})

describe('createStrippedStream – tool prefix rewriting across chunk boundaries', () => {
  test('strips tool names split across chunk boundaries', async () => {
    const fullText =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Bash"}}\n\n'
    const mid = fullText.indexOf('mcp_Bash') + 3
    const chunks = [fullText.slice(0, mid), fullText.slice(mid)]

    const stripped = createStrippedStream(makeStream(chunks))
    const text = await stripped.text()

    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_Bash')
  })
})
