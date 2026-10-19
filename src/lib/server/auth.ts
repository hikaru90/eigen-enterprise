import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth/minimal'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { sveltekitCookies } from 'better-auth/svelte-kit'
import { count } from 'drizzle-orm'
import { dev } from '$app/environment'
import { getRequestEvent } from '$app/server'
import { resolveAccountKindForNewUser } from '$lib/auth/account-kind'
import { syncOwleryContactForVerifiedUser } from '$lib/server/auth-owlery-sync'
import { buildSocialProvidersConfig, listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { normalizeUserNameFields } from '$lib/server/auth-user-name'
import { deliverSignInCode, recordDeliveryFailure } from '$lib/server/auth/deliver-code'
import { ownerPolicyForNewUser } from '$lib/server/auth/owner-policy'
import { authDb } from '$lib/server/db/auth-db'
import { user as userTable } from '$lib/server/db/auth.schema'
import { recordSignInCode, recordVerificationLink } from '$lib/server/e2e/verification-link-store'
import { env } from '$lib/server/env/private-env'
import { isOwleryMailConfigured, sendTransactionalEmail } from '$lib/server/owlery/mail'

const socialProviders = buildSocialProvidersConfig(env)
const enabledSocialProviderIds = listEnabledSocialProviderIds(env)
const mailConfigured = isOwleryMailConfigured(env)

/**
 * Better Auth requires an absolute URL with a scheme. Some hosts set `ORIGIN` to a bare hostname
 * (e.g. `app.example.com`), which `new URL` rejects until `https://` is prepended.
 */
export function normalizeAuthOrigin(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (!trimmed) {
    throw new Error('ORIGIN is not set (required for Better Auth baseURL)')
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`ORIGIN is not a valid URL: "${trimmed}"`)
  }
  return url.href.replace(/\/$/, '')
}

function linkEmailHtml(label: string, url: string): string {
  const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<p>${label}</p><p><a href="${escaped}">${escaped}</a></p>`
}

/**
 * Dev contract: there is no local mail server — auth links always go to the
 * terminal, whether or not Owlery is configured. Production is unaffected
 * (links are delivered by email only).
 */
function logAuthLink(kind: string, email: string, url: string): void {
  if (!dev) return
  console.log(`[auth] DEV ${kind} link for ${email}:\n  ${url}`)
}

function queueTransactionalEmail(input: {
  to: string
  subject: string
  html: string
  text: string
}): void {
  void sendTransactionalEmail(env, input).catch((err) => {
    console.error('[auth] transactional email failed', {
      to: input.to,
      subject: input.subject,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export const auth = betterAuth({
  baseURL: normalizeAuthOrigin(env.ORIGIN),
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(authDb, { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: mailConfigured,
    ...(mailConfigured
      ? {
          sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
            logAuthLink('Password reset', user.email, url)
            queueTransactionalEmail({
              to: user.email,
              subject: 'Reset your Eigen password',
              text: `Click the link to reset your password:\n${url}`,
              html: linkEmailHtml('Click the link to reset your password:', url),
            })
          },
        }
      : {}),
  },
  ...(mailConfigured
    ? {
        emailVerification: {
          sendOnSignUp: true,
          sendOnSignIn: true,
          autoSignInAfterVerification: true,
          sendVerificationEmail: async ({
            user,
            url,
          }: {
            user: { email: string }
            url: string
          }) => {
            recordVerificationLink(user.email, url)
            logAuthLink('Email verification', user.email, url)
            queueTransactionalEmail({
              to: user.email,
              subject: 'Verify your Eigen email',
              text: `Click the link to verify your email:\n${url}`,
              html: linkEmailHtml('Click the link to verify your email:', url),
            })
          },
          afterEmailVerification: async (user) => {
            await syncOwleryContactForVerifiedUser(user)
          },
        },
      }
    : {}),
  ...(enabledSocialProviderIds.length > 0
    ? {
        socialProviders,
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: enabledSocialProviderIds,
          },
        },
      }
    : {}),
  user: {
    changeEmail: {
      enabled: true,
      /** Without a mailer, allow immediate updates; with Owlery, confirm via email. */
      updateEmailWithoutVerification: !mailConfigured,
      ...(mailConfigured
        ? {
            sendChangeEmailConfirmation: async ({
              user,
              newEmail,
              url,
            }: {
              user: { email: string }
              newEmail: string
              url: string
            }) => {
              logAuthLink('Email change confirmation', user.email, url)
              queueTransactionalEmail({
                to: user.email,
                subject: 'Confirm your Eigen email change',
                text: `Confirm changing your email to ${newEmail}:\n${url}`,
                html: linkEmailHtml(
                  `Confirm changing your email to <strong>${newEmail.replace(/</g, '&lt;')}</strong>:`,
                  url,
                ),
              })
            },
          }
        : {}),
    },
    additionalFields: {
      /** Given name — captured from the signup form or the OAuth profile (mapProfileToUser). */
      firstName: {
        type: 'string',
        required: false,
        input: true,
        returned: true,
      },
      /** Family name — optional on the signup form; mapped from the OAuth profile when present. */
      lastName: {
        type: 'string',
        required: false,
        input: true,
        returned: true,
      },
      onboardingCompleted: {
        type: 'boolean',
        required: false,
        defaultValue: false,
        input: false,
        returned: true,
      },
      role: {
        type: 'string',
        required: false,
        defaultValue: 'user',
        input: false,
        returned: true,
      },
      accountKind: {
        type: 'string',
        required: false,
        defaultValue: 'production',
        input: false,
        returned: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const [{ n }] = await authDb.select({ n: count() }).from(userTable)
          // ee sets EE_WORKLOAD on every workload it runs (ee/src/units.ts).
          const { role } = ownerPolicyForNewUser({ existingUsers: Number(n), managedByEe: Boolean(env.EE_WORKLOAD) })
          return {
            data: {
              ...user,
              ...normalizeUserNameFields(user),
              role,
              accountKind: resolveAccountKindForNewUser(String(user.email ?? '')),
            },
          }
        },
        after: async (user) => {
          await syncOwleryContactForVerifiedUser(user)
        },
      },
    },
  },
  plugins: [
    // Passwordless: an emailed 6-digit code signs up a new address and signs in an existing one.
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== 'sign-in') throw new Error(`unsupported email code type: ${type}`)
        try {
          await deliverSignInCode(
            { email, otp },
            {
              mailConfigured,
              dev,
              send: (mail) => sendTransactionalEmail(env, mail),
              log: (line) => console.log(line),
              record: recordSignInCode,
            },
          )
        } catch (err) {
          recordDeliveryFailure(email, err) // Better Auth swallows this; requestCode reports it.
          throw err
        }
      },
    }),
    sveltekitCookies(getRequestEvent), // make sure this is the last plugin in the array
  ],
})
