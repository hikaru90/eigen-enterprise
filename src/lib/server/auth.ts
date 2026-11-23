import { passkey } from '@better-auth/passkey'
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
import { freshSessionHook } from '$lib/server/auth/fresh-session'
import { refuseCoworkerSession } from '$lib/server/auth/coworker-sign-in'
import { claimScope, inviteScope, NotAMemberError, openJoinScope, ownerPolicyForNewUser } from '$lib/server/auth/owner-policy'
import { authDb } from '$lib/server/db/auth-db'
import { user as userTable } from '$lib/server/db/auth.schema'
import { recordSignInCode } from '$lib/server/e2e/verification-link-store'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'
import { dbMemberStore } from '$lib/server/members/db-store'
import { openJoinOn, recordOpenJoin } from '$lib/server/members/open-join-db'
import { foundingCompanyName } from '$lib/server/overview/sources'

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
  // Dev follows the request origin, so the server works on whatever port it
  // landed on (5174, 5175, …): better-auth's router only serves /api/auth/*
  // when the serving origin matches baseURL. Production pins ORIGIN.
  baseURL: dev ? undefined : normalizeAuthOrigin(env.ORIGIN),
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(authDb, { provider: 'pg' }),
  // Sign-in is passwordless (emailOTP below): the code proves the address, so
  // there is no separate verification-by-link. Password endpoints stay enabled
  // only so pre-passwordless accounts aren't stranded; no UI offers them.
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  session: {
    // The owner's call: a machine that has signed in once with a code stays
    // signed in — the session is the device's credential. A year, and every
    // active day extends it, so a used machine never times out mid-work.
    expiresIn: 60 * 60 * 24 * 365,
    updateAge: 60 * 60 * 24,
    // Better Auth's "signed in within a day" check is off; `hooks.before` below runs ours, which
    // only asks for a new sign-in when an email code can actually deliver one (fresh-session.ts).
    freshAge: 0,
  },
  hooks: { before: freshSessionHook(() => companyMail().isConfigured()) },
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
      /** The profile picture's SHA-256 (set only by /api/profile/avatar; the profile gate reads it). */
      avatarSha256: {
        type: 'string',
        required: false,
        input: false,
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
    // AI co-workers never sign in (plan/phase-ai-coworkers.md §3): every sign-in path makes a
    // session, and none is made for a co-worker (fail loud).
    session: {
      create: {
        before: async (session) => {
          await refuseCoworkerSession(String(session.userId))
        },
      },
    },
    user: {
      create: {
        before: async (user) => {
          const [{ n }] = await authDb.select({ n: count() }).from(userTable)
          // ee sets EE_WORKLOAD on every workload it runs (ee/src/units.ts).
          const email = String(user.email ?? '').toLowerCase()
          const invite = inviteScope.getStore()
          if (invite && invite.email !== email) throw new Error('this invite belongs to a different email address')
          // Open join (members.open_join): /signup verified this address's code; the
          // setting is re-read now, at the moment the account is made.
          const joining = openJoinScope.getStore()
          if (joining && joining.email !== email) throw new Error('this sign-up belongs to a different email address')
          let role
          try {
            role = ownerPolicyForNewUser({
              existingUsers: Number(n),
              managedByEe: Boolean(env.EE_WORKLOAD),
              viaClaim: claimScope.getStore() === true,
              invite: invite ? { role: invite.role } : null,
              openJoin: joining ? await openJoinOn() : false,
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
          // Joined through open join (not founding, not invited): like an accepted invite, no company onboarding.
          if (openJoinScope.getStore() && !inviteScope.getStore() && user.role === 'member') await recordOpenJoin(user.id)
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
    // Passkeys: after a code sign-in, Settings → Passkeys registers this
    // machine's platform authenticator as a way back in — no code, no email.
    // Dev passes no static origin: the plugin then verifies against the
    // request's own Origin header, so any dev port works. Production pins it
    // (PASSKEY_ORIGIN, else ORIGIN) because its origin is stable and known.
    passkey({
      rpID: new URL(normalizeAuthOrigin(env.ORIGIN)).hostname,
      rpName: 'Eigen Enterprise',
      ...(!dev && (env.PASSKEY_ORIGIN?.trim() || env.ORIGIN.trim())
        ? {
            origin: normalizeAuthOrigin(
              (env.PASSKEY_ORIGIN?.trim() || env.ORIGIN.trim()) as string,
            ),
          }
        : {}),
    }),
    sveltekitCookies(getRequestEvent), // make sure this is the last plugin in the array
  ],
})
