# Sending email through eigenEnterprise (for agents)

One endpoint, one recipient per call: `POST /api/mail/send`. Mail goes out through
the company's Email module (Amazon SES) **immediately**, with no approval round.

## The key

- The owner creates it on the **Email** module page (`/m/email`, "Create a key that
  can send mail") or on `/api-keys` with **Can send mail** ticked. That tick is the
  owner's consent to send. It can be switched off or the key revoked at any time.
- The key looks like `eigen_<hex>` and is shown once. Keep it in a secret
  (e.g. `EIGEN_API_KEY`); never put it in a prompt, a log or a repo.
- Only API keys work here. A browser session cookie gets `401`.
- A key cannot grant itself (or another key) "Can send mail"; only the signed-in owner can.

## Send

```bash
curl -sS -X POST https://<console-host>/api/mail/send \
  -H "Authorization: Bearer $EIGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"ada@example.com","subject":"Hello","text":"Hi Ada","idempotencyKey":"welcome-ada-1"}'
```

## Fields (JSON; unknown fields are rejected)

| Field | Required | Rule |
|---|---|---|
| `to` | yes | one email address |
| `subject` | yes | 1 to 998 characters |
| `text` | yes | non-empty plain text |
| `html` | no | HTML body; without it the text is sent as simple HTML too |
| `replyTo` | no | email address |
| `idempotencyKey` | no | 1 to 128 characters; strongly recommended |

## Responses

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"id","status":"sent","to"}` | sent (or an idempotent repeat of a send) |
| 400 | `{"error":"invalid_request","fields":{...}}` | fix the named fields |
| 401 | `{"error":"unauthorized"}` | missing, wrong or revoked key, or a cookie |
| 403 | `{"error":"forbidden","message":"this key may not send mail"}` | owner has not ticked "Can send mail" |
| 409 | `{"error":"idempotency_conflict","message"}` | idempotencyKey reused with a different body, or the first send is still running |
| 429 | `{"error":"rate_limited","message"}` + `Retry-After` header | over 60 mails per minute for this key |
| 502 | `{"error":"delivery_failed","message"}` | Amazon refused; `message` says why in plain words |
| 503 | `{"error":"mail_not_configured","message"}` | the owner has not set up Email yet |

## Retry rule

Always send an `idempotencyKey`. Retry with the **same** key and the **same** body
on network errors, `429` (after `Retry-After` seconds), `502` and `503`. Within 24h the
same key returns the first result (same `id`) and never sends twice. A failed send
does not use up the key. Never retry `400`, `401` or `403` without fixing the cause.

## Amazon SES sandbox

A new SES account is in the sandbox: it only delivers to addresses Amazon has
verified. Sending elsewhere returns `502 delivery_failed` with Amazon's reason. The
owner either verifies the recipient in the SES console or requests production access.

## What is recorded

Every attempt is audited with the key name, the recipient, the outcome and the id;
never the key or the mail content. Sends show in Overview recent activity as
"Sent an email to <to> (via key <name>)".
