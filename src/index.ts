import { type Credential, Plugin } from '@opencode/plugin'
import { Money } from '@opencode/schema/money'
import { authorize, exchange, refreshToken } from './auth.ts'
import { REQUIRED_BETAS } from './constants.ts'
import { parseQuotaHeaders } from './quota-headers.ts'
import { writeQuotaState } from './quota-state.ts'
import { isRecoverableRefusalModel } from './server-fallback.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const PLUGIN_ID = '@sahiljassal/opencode-anthropic-auth'
const INTEGRATION_ID = 'anthropic'
const REFRESH_CACHE_GRACE_MS = 30_000

// `methodID` is a branded `Integration.MethodID` at the type level (a
// compile-time-only tag — there's no runtime representation), so a plain
// string literal needs a cast to satisfy the branded field.
const METHOD_ID = 'claude-max' as Credential.OAuth['methodID']

function toCredential(exchanged: {
  refresh: string
  access: string
  expires: number
}): Credential.OAuth {
  return {
    type: 'oauth',
    methodID: METHOD_ID,
    refresh: exchanged.refresh,
    access: exchanged.access,
    expires: exchanged.expires,
  }
}

async function resolveActiveOAuth(
  ctx: Plugin.Context,
): Promise<Credential.OAuth | undefined> {
  const connection = await ctx.integration.connection.active(INTEGRATION_ID)
  if (!connection) return undefined

  const credential = await ctx.integration.connection.resolve(connection)
  if (credential?.type === 'oauth' && credential.methodID === METHOD_ID) {
    return credential
  }

  return undefined
}

function warnIfInsecureUnsupported() {
  if (!isInsecure()) return
  console.warn(
    `[${PLUGIN_ID}] ANTHROPIC_INSECURE is set, but OpenCode v2 plugin ` +
      'request hooks cannot disable TLS verification for a custom ' +
      'ANTHROPIC_BASE_URL endpoint. TLS verification remains enabled — ' +
      'requests to an untrusted/self-signed endpoint will fail.',
  )
}

function isTransformedOAuthRequest(request: Request): boolean {
  const betas = new Set(
    (request.headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim()),
  )
  return (
    request.headers.get('authorization')?.startsWith('Bearer ') === true &&
    REQUIRED_BETAS.every((beta) => betas.has(beta)) &&
    new URL(request.url).searchParams.get('beta') === 'true'
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    warnIfInsecureUnsupported()

    // Retain successful refreshes for this plugin generation so a host call
    // holding the rotated token cannot submit it again before persistence.
    const refreshInFlight = new Map<string, Promise<Credential.OAuth>>()
    const refreshCredential = async (credential: Credential.OAuth) => {
      const existing = refreshInFlight.get(credential.refresh)
      if (existing) return existing

      const pending = (async () => {
        const result = await refreshToken(credential.refresh)
        if (result.type === 'failed') {
          throw new Error(`Anthropic token refresh failed: ${result.status}`)
        }
        return toCredential(result)
      })()
      refreshInFlight.set(credential.refresh, pending)
      try {
        const rotated = await pending
        const timer = setTimeout(() => {
          if (refreshInFlight.get(credential.refresh) === pending) {
            refreshInFlight.delete(credential.refresh)
          }
        }, REFRESH_CACHE_GRACE_MS)
        timer.unref?.()
        return rotated
      } catch (error) {
        if (refreshInFlight.get(credential.refresh) === pending) {
          refreshInFlight.delete(credential.refresh)
        }
        throw error
      }
    }

    const integrationRegistration = await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: 'oauth',
          label: 'Claude Pro/Max',
        },
        authorize: async () => {
          const result = await authorize('max')
          return {
            url: result.url,
            instructions: 'Paste the authorization code here:',
            mode: 'code',
            callback: async (code: string) => {
              const exchanged = await exchange(
                code,
                result.verifier,
                result.redirectUri,
                result.state,
              )
              if (exchanged.type === 'failed') {
                throw new Error(
                  'Failed to exchange the Claude Pro/Max authorization code. ' +
                    'Double-check that you pasted the full code and try again.',
                )
              }
              return toCredential(exchanged)
            },
          }
        },
        refresh: refreshCredential,
      })
    })

    // Drives ctx.model.transform's cost zeroing without an async connection
    // lookup inside its synchronous callback — kept in sync by every place
    // that already resolves the active OAuth connection.
    let anthropicUsesOAuth = (await resolveActiveOAuth(ctx)) !== undefined
    const syncOAuthCostState = async (ctx2: Plugin.Context) => {
      const active = (await resolveActiveOAuth(ctx2)) !== undefined
      if (active === anthropicUsesOAuth) return
      anthropicUsesOAuth = active
      await ctx2.model.reload()
    }

    // Zeroes every cost tier so OAuth-billed usage shows no API price.
    const modelRegistration = await ctx.model.transform((editor) => {
      if (!anthropicUsesOAuth) return
      for (const model of editor.list(INTEGRATION_ID)) {
        model.cost = model.cost.map((tier) => ({
          ...tier,
          input: Money.USDPerMillionTokens.zero,
          output: Money.USDPerMillionTokens.zero,
          cache: {
            read: Money.USDPerMillionTokens.zero,
            write: Money.USDPerMillionTokens.zero,
          },
        }))
      }
    })

    const requestRegistration = await ctx.session.hook(
      'http.request',
      async (event) => {
        if (event.model.providerID !== INTEGRATION_ID) return
        const credential = await resolveActiveOAuth(ctx)
        if (!credential) return
        await syncOAuthCostState(ctx)

        const request = event.request
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
        const bodyText = hasBody ? await request.clone().text() : undefined
        const rewrittenBody =
          bodyText !== undefined ? rewriteRequestBody(bodyText) : undefined

        let parsedBody: unknown
        if (rewrittenBody !== undefined) {
          try {
            parsedBody = JSON.parse(rewrittenBody)
          } catch {
            parsedBody = undefined
          }
        }

        const headers = mergeHeaders(request)
        setOAuthHeaders(headers, credential.access, event.model.id, parsedBody)
        if (rewrittenBody !== undefined) headers.delete('content-length')

        const { input: rewrittenInput } = rewriteUrl(request.url)
        const url =
          typeof rewrittenInput === 'string'
            ? rewrittenInput
            : rewrittenInput instanceof Request
              ? rewrittenInput.url
              : rewrittenInput.toString()

        event.request = new Request(url, {
          method: request.method,
          headers,
          body: rewrittenBody,
          signal: request.signal,
        })
      },
    )

    const responseRegistration = await ctx.session.hook(
      'http.response',
      (event) => {
        if (event.model.providerID !== INTEGRATION_ID) return
        if (!isTransformedOAuthRequest(event.request)) return

        try {
          const quota = parseQuotaHeaders(event.response.headers)
          if (quota) writeQuotaState(quota)
        } catch {
          // Sidebar visibility is best-effort; never fail the request over it.
        }

        const serverFallbackModel = isRecoverableRefusalModel(event.model.id)
          ? event.model.id
          : undefined
        event.response = createStrippedStream(event.response, {
          serverFallbackModel,
        })
      },
    )

    return async () => {
      await integrationRegistration.dispose()
      await modelRegistration.dispose()
      await requestRegistration.dispose()
      await responseRegistration.dispose()
    }
  },
})
