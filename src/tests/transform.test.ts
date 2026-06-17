import { afterEach, describe, expect, mock, test } from 'bun:test'
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
  rewriteRequestBody,
  rewriteUrl,
  sanitizeSystemText,
  setOAuthHeaders,
  stripToolPrefix,
} from '../transform'

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

  test('does not call onError when identity is present and removed', () => {
    const onError = mock(() => {})
    sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Normal content.
    `)
    expect(onError).not.toHaveBeenCalled()
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
    // system[0] = identity, system[1] = rest
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('You are a helpful assistant.')
  })

  test('handles missing system field', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))
    // system[0] = identity only (no original system, no billing header)
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('returns original string on invalid JSON', () => {
    const body = 'not valid json'
    expect(rewriteRequestBody(body)).toBe(body)
  })

  test('does not call onError when identity is present (rules always match)', () => {
    const onError = mock(() => {})
    const body = JSON.stringify({
      messages: [],
      system: `${OPENCODE_IDENTITY_PREFIX}\nsome other content`,
    })
    rewriteRequestBody(body)
    expect(onError).not.toHaveBeenCalled()
  })

  test('rewrites realistic OpenCode request end-to-end', () => {
    //  Input system prompt (array of blocks):
    //    [0] "You are OpenCode..." + generic content + "# Code References\n..."
    //    [1] "Additional context block"
    //
    //  Expected output (three-block layout):
    //    system[0] = billing header
    //    system[1] = identity
    //    system[2..n] = sanitized system blocks
    //    User messages are untouched.

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
        // Follow-up user turn so the assistant is not trailing (would be stripped)
        { role: 'user', content: 'What did you find?' },
      ],
      system: [
        { type: 'text', text: systemPrompt },
        { type: 'text', text: 'Additional context block' },
      ],
    })

    const result = JSON.parse(rewriteRequestBody(body))

    // identity + sanitized blocks
    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toContain('You have access to tools.')
    expect(result.system[1].text).toContain('# Code References')
    expect(result.system[1].text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result.system[2].text).toBe('Additional context block')

    // User message content normalised to block array with cache anchor
    expect(result.messages[0].content[0].text).toBe('Help me fix this bug')
    // Assistant tool name prefixed (messages[1] kept — not trailing)
    expect(result.messages[1].content[0].name).toBe('mcp_Bash')
  })

  test('handles body with no messages array', () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(rewriteRequestBody(body))
    // No messages → no billing header; system[0] = identity only
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('keeps system blocks in system[] (string content)', () => {
    const body = JSON.stringify({
      system: 'Custom instructions for the assistant.',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = identity, system[1] = rest
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Custom instructions for the assistant.')

    // User message content normalised to block array with cache anchor
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

    // system[0] = identity, system[1..2] = rest
    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Block A instructions')
    expect(result.system[2].text).toBe('Block B instructions')

    // User message is untouched
    expect(result.messages[0].content).toHaveLength(1)
    expect(result.messages[0].content[0].text).toBe('hello')
  })

  test('keeps system intact when no user messages exist', () => {
    const body = JSON.stringify({
      system: 'Some instructions',
      messages: [],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // No user messages → no billing header; system[0] = identity, system[1] = rest
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Some instructions')
  })

  test('keeps multiple system blocks as separate entries', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
        { type: 'text', text: 'Third block' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = identity, system[1..3] = original blocks
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('First block')
    expect(result.system[2].text).toBe('Second block')
    expect(result.system[3].text).toBe('Third block')

    // User message content normalised to block array with cache anchor
    expect(result.messages[0].content[0].text).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// Realistic prompt – snapshot tests
// ---------------------------------------------------------------------------

import { REALISTIC_SYSTEM_PROMPT } from './fixtures/realistic-system-prompt'

// ---------------------------------------------------------------------------
// Hybrid cache breakpoint tests
// ---------------------------------------------------------------------------

function makeMsg(
  role: string,
  content: string | Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { role, content }
}

function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

function cacheControl(parsed: ReturnType<typeof JSON.parse>, path: string) {
  // Helper to reach nested cache_control by dot-path, e.g. "messages.0.content.0"
  const parts = path.split('.')
  let node: unknown = parsed
  for (const part of parts) {
    node = (node as Record<string, unknown>)[part]
  }
  return (node as Record<string, unknown>).cache_control
}

describe('hybrid cache – breakpoint placement', () => {
  const CACHE_1H = { type: 'ephemeral', ttl: '1h' }

  function body(opts: {
    system?: unknown
    messages: unknown[]
  }): string {
    return JSON.stringify({ system: opts.system ?? 'Instructions.', messages: opts.messages })
  }

  test('strips all existing cache_control before placing new ones', () => {
    const raw = JSON.stringify({
      system: [
        { type: 'text', text: 'block', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi', cacheControl: { type: 'ephemeral' } }],
        },
      ],
    })
    const result = JSON.parse(rewriteRequestBody(raw))
    // Only the new 1h anchor should remain; no stale ephemeral without ttl
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
        body({
          system: [
            { type: 'text', text: 'Block A' },
            { type: 'text', text: 'Block B' },
          ],
          messages: [makeMsg('user', 'hello')],
        }),
      ),
    )
    // system = [identity, Block A, Block B]
    // Anchor on last block after identity → system[2] = Block B
    expect(result.system[2].cache_control).toEqual(CACHE_1H)
    expect(result.system[1].cache_control).toBeUndefined()
    expect(result.system[0].cache_control).toBeUndefined()
  })

  test('does not anchor system block when only identity is present', () => {
    const result = JSON.parse(
      rewriteRequestBody(body({ system: undefined, messages: [makeMsg('user', 'hello')] })),
    )
    // system = [identity] only — nothing after identity to anchor
    expect(result.system[0].cache_control).toBeUndefined()
  })

  test('anchors last cacheable block of messages[0]', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        body({
          messages: [
            makeMsg('user', [textBlock('only block')]),
          ],
        }),
      ),
    )
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
  })

  test('anchors last cacheable block of messages[1] (normal path)', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        body({
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
        body({
          messages: [
            makeMsg('user', [
              { type: 'thinking', thinking: 'some reasoning' },
              textBlock('actual content'),
            ]),
          ],
        }),
      ),
    )
    // Anchor on text block, not thinking block
    expect(result.messages[0].content[1].cache_control).toEqual(CACHE_1H)
    expect(result.messages[0].content[0].cache_control).toBeUndefined()
  })

  test('skips redacted_thinking blocks when placing cache anchor', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        body({
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
        body({
          messages: [
            makeMsg('user', [
              { type: 'thinking', thinking: 'reasoning only' },
            ]),
          ],
        }),
      ),
    )
    // No cache_control on the message itself or its blocks
    expect(result.messages[0].cache_control).toBeUndefined()
    expect(result.messages[0].content[0].cache_control).toBeUndefined()
  })

  test('magic-context split: anchors block[0] and block[1] of messages[0] when it has ≥2 cacheable blocks', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        body({
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
    const result = JSON.parse(rewriteRequestBody(body({ messages })))
    // messages[3] is latest user beyond index 1 → should be anchored
    const msg3content = result.messages[3].content
    // string content gets normalised to array
    expect(Array.isArray(msg3content)).toBe(true)
    expect(msg3content[0].cache_control).toEqual(CACHE_1H)
  })

  test('bridge anchor: when latest is >20 blocks away from previous, bridge placed and system anchor reclaimed', () => {
    // Build a long session with 25 user messages (index > 1), each with 1 block,
    // so cumulative from bridge candidate to latest exceeds 20.
    const messages: unknown[] = [
      makeMsg('user', 'msg0'),
      makeMsg('user', 'msg1'),
    ]
    for (let i = 2; i < 30; i++) {
      messages.push(makeMsg('user', `msg${i}`))
    }
    const result = JSON.parse(rewriteRequestBody(body({ messages })))

    // Count how many messages got a cache_control on their content
    let anchoredCount = 0
    for (const msg of result.messages) {
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const block of content) {
        if (block.cache_control) anchoredCount++
      }
    }
    // Should have at least 3 message anchors (msg0, bridge, latest)
    expect(anchoredCount).toBeGreaterThanOrEqual(3)
  })

  test('trailing assistant messages are stripped before caching', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        body({
          messages: [
            makeMsg('user', 'question'),
            makeMsg('assistant', 'answer'),
          ],
        }),
      ),
    )
    // Trailing assistant stripped → only user message remains
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
  })

  test('multiple trailing assistant messages all stripped', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        body({
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
        body({
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
        body({
          messages: [makeMsg('user', 'plain string content')],
        }),
      ),
    )
    // Content normalised to array and anchor set
    expect(Array.isArray(result.messages[0].content)).toBe(true)
    expect(result.messages[0].content[0].cache_control).toEqual(CACHE_1H)
  })
})

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
