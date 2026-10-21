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
import { claimScope, inviteScope, NotAMemberError, ownerPolicyForNewUser } from '$lib/server/auth/owner-policy'
import { dbMemberStore } from '$lib/server/members/db-store'
import { foundingCompanyName } from '$lib/server/overview/sources'
import { authDb } from '$lib/server/db/auth-db'
import { user as userTable } from '$lib/server/db/auth.schema'
import { recordSignInCode } from '$lib/server/e2e/verification-link-store'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'

const socialProviders = buildSocialProvidersConfig(env)
const enabledSocialProviderIds = listEnabledSocialProviderIds(env)

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
  void companyMail().send(input).catch((err) => {
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
  // Sign-in is passwordless (emailOTP below): the code proves the address, so
  // there is no separate verification-by-link. Password endpoints stay enabled
  // only so pre-passwordless accounts aren't stranded; no UI offers them.
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
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
      /** Changing the address is confirmed by email (company mail, set up in the onboarding). */
      updateEmailWithoutVerification: false,
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
        defaultValue: 'member',
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
          const email = String(user.email ?? '').toLowerCase()
          const invite = inviteScope.getStore()
          if (invite && invite.email !== email) throw new Error('this invite belongs to a different email address')
          let role
          try {
            role = ownerPolicyForNewUser({
              existingUsers: Number(n),
              managedByEe: Boolean(env.EE_WORKLOAD),
              viaClaim: claimScope.getStore() === true,
              invite: invite ? { role: invite.role } : null,
            }).role
          } catch (err) {
            if (err instanceof NotAMemberError) throw new NotAMemberError(await foundingCompanyName())
            throw err
          }
          // An invite works once: consumed atomically right before its account is created.
          if (invite && !(await dbMemberStore.consumeInvite(invite.inviteId, new Date()))) {
            throw new Error('This invite was already used or has expired.')
          }
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
              mailConfigured: await companyMail().isConfigured(),
              dev,
              send: (mail) => companyMail().send(mail),
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
