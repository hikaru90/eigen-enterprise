import { test } from '@playwright/test'
import { completeOnboardingOverlay } from './release-helpers'
import { registerUser } from './test-helpers'
import { assertVoiceTranscribeApi } from './voice-capture-helpers'

test.describe('Voice capture @release', () => {
  // The Capture page's mic is gone (plan/concept-memory-one-door.md): voice goes in through
  // the Ask bar's dictation (its own component tests). The transcribe API stays.
  test('the transcribe API turns speech into text', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(
      !process.env.PLATFORM_LLM_BASE_URL?.trim() || !process.env.PLATFORM_LLM_API_KEY?.trim(),
      'eigenInference (PLATFORM_LLM_*) required for real speech to text',
    )
    test.skip(
      !process.env.PAYPAL_SANDBOX_BUYER_EMAIL?.trim() ||
        !process.env.PAYPAL_SANDBOX_BUYER_PASSWORD?.trim(),
      'PayPal sandbox buyer required for platform credits',
    )

    await context.grantPermissions(['microphone'], {
      origin: baseURL ?? 'http://localhost:5173',
    })

    await registerUser(context, page)
    await completeOnboardingOverlay(page)
    await test.step('transcribe API returns speech text', async () => {
      await assertVoiceTranscribeApi(page)
    })
  })
})
