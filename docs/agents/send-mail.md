# Sending email through eigenEnterprise (for agents)

eigenEnterprise sends the company's email through its **Email** module (Amazon SES).
An agent sends mail by calling the kernel tool **`email.send_mail`** over the MCP
endpoint, authenticated with an API key. Every call is permission-checked, audited,
and — for sending mail — **approval-gated** (see "Approval" below).

## 1. Get an API key (the owner does this once)

In eigenEnterprise: **Settings → API keys → Create key**. The key looks like
`eigen_<hex>` and is shown once. Give it to the agent as a secret
(e.g. env var `EIGEN_API_KEY`); never put it in a prompt, a log or a repo.

## 2. Endpoint

```
POST https://<console-host>/api/mcp
Authorization: Bearer <EIGEN_API_KEY>
Content-Type: application/json
Accept: application/json, text/event-stream
```

`<console-host>` is the address you open eigenEnterprise at, e.g. `os.cerberusblue.com`.
The endpoint speaks MCP (JSON-RPC 2.0). Any MCP client can use it with the URL and the
Bearer header; plain HTTP works too:

## 3. Send a mail

```bash
curl -sS https://os.cerberusblue.com/api/mcp \
  -H "Authorization: Bearer $EIGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "email.send_mail",
      "arguments": {
        "to": "someone@example.com",
        "subject": "Hello from Cerberus Blue",
        "text": "Plain-text body (required).",
        "html": "<p>HTML body (required).</p>",
        "replyTo": "a.bueckner@cerberusblue.com"
      }
    }
  }'
```

Arguments:

| field | required | notes |
|---|---|---|
| `to` | yes | one valid address |
| `subject` | yes | non-empty |
| `text` | yes | plain-text body, non-empty |
| `html` | yes | HTML body, non-empty |
| `replyTo` | no | valid address |

The sender is always the company's configured sender address (set in the Email module);
an agent cannot choose another `from`.

To see which tools exist and their exact input schemas:

```bash
curl -sS https://os.cerberusblue.com/api/mcp \
  -H "Authorization: Bearer $EIGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 4. Approval — why a call can "succeed" but no mail goes out

Sending mail is an external action, so it waits for the owner's decision unless the
owner allows it:

- **Ask every time** / **Make reasonable choices** (approval dropdown under the chat
  input): the first `email.send_mail` call does **not** send. It returns an
  `approval_required` error and creates a pending approval. The owner approves it in
  the chat (Approve button). The agent must then **call again with the same input** —
  the approved call is what sends.
- **Allow everything**: the call sends immediately (still audited).

So an agent must treat `approval_required` as "waiting for the owner", not as a
failure, and retry the identical call after the owner approved.

## 5. Results and errors

- Success: the tool result describes the sent message.
- `approval_required`: see above.
- `module_inactive`: the Email module is off — the owner switches it on.
- `permission_denied`: the key is not allowed to send.
- Validation errors name the field that is wrong (e.g. `to` is not an email).
- An error from Amazon SES (sender not verified, sandbox, wrong keys) comes back as a
  plain message. **SES sandbox:** until the AWS account is moved out of the sandbox,
  Amazon only delivers to **verified** recipient addresses — mail to anyone else is
  rejected. The owner requests production access in the AWS SES console
  ("Request production access").

## 6. Rules for agents

- Never log or echo the API key.
- One recipient per call; loop for several, and keep volume reasonable (SES rate limits).
- Every send appears in **Overview → Recent activity** as "Sent an email to …".
