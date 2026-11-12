# Calendar sync: OAuth apps to register (owner steps)

For `plan/calendar.md` K5 (Google) and K6 (Microsoft). Each person later connects their own
calendar with these apps; the apps themselves are registered once per company.

Console host below: `os.cerberusblue.com`. Use your console host if it differs.
The callback paths are fixed by K5/K6: `/api/calendar/oauth/google/callback` and
`/api/calendar/oauth/microsoft/callback`.

The secrets are only read once K5/K6 ship (they declare them in the os workload's `ee.json`).
Until then `ee` rejects secrets the workload doesn't declare, so register the apps now and set
the secrets when that release is on the server.

## Google (Google Calendar API)

1. https://console.cloud.google.com → project picker → **New project** (e.g. "eigenEnterprise Calendar"). Select it.
2. **APIs & Services → Library** → search "Google Calendar API" → **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - **Branding:** app name, support email, the console host as app domain, a privacy policy URL (required later for verification).
   - **Audience:** *Internal* if everyone uses your Google Workspace domain (no verification needed); otherwise *External*, and add each person under **Test users** until the app is verified.
   - **Data access → Add or remove scopes:** `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.readonly` (both are "sensitive" scopes: External apps need Google's verification before people outside the test list can connect).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**, name "eigenEnterprise".
   - **Authorized redirect URIs:** `https://os.cerberusblue.com/api/calendar/oauth/google/callback`
   - Create → copy **Client ID** and **Client secret**.
5. On the server (after the K5 release is installed):
   ```bash
   printf '%s' '<client id>' | ee secret set os GOOGLE_CALENDAR_CLIENT_ID
   ```
   ```bash
   printf '%s' '<client secret>' | ee secret set os GOOGLE_CALENDAR_CLIENT_SECRET
   ```

Note: this is a separate client from Google sign-in (`GOOGLE_CLIENT_ID`), so sign-in keeps its narrow scopes.

## Microsoft (Microsoft 365 / Outlook via Microsoft Graph)

1. https://entra.microsoft.com → **Identity → Applications → App registrations → New registration**.
   - Name "eigenEnterprise Calendar".
   - **Supported account types:** "Accounts in any organizational directory and personal Microsoft accounts" (works for work and outlook.com accounts). Only your company's tenant: "this organizational directory only".
   - **Redirect URI:** platform **Web**, `https://os.cerberusblue.com/api/calendar/oauth/microsoft/callback`.
   - Register → copy **Application (client) ID** and **Directory (tenant) ID**.
2. **API permissions → Add a permission → Microsoft Graph → Delegated permissions:** `Calendars.ReadWrite`, `offline_access`, `User.Read` → Add. In a work tenant, **Grant admin consent** if your admin requires it.
3. **Certificates & secrets → Client secrets → New client secret** (24 months) → copy the **Value** right away (it's shown once). Put a reminder in your calendar to renew it before it expires.
4. On the server (after the K6 release is installed):
   ```bash
   printf '%s' '<application id>' | ee secret set os MICROSOFT_CALENDAR_CLIENT_ID
   ```
   ```bash
   printf '%s' '<secret value>' | ee secret set os MICROSOFT_CALENDAR_CLIENT_SECRET
   ```
   ```bash
   printf '%s' 'common' | ee secret set os MICROSOFT_CALENDAR_TENANT
   ```
   (`common` for "any directory + personal accounts"; your tenant id for "this directory only".)

## Push notifications from the providers

Google watch channels and Graph subscriptions call back to the console host over HTTPS
(`/api/calendar/push/google`, `/api/calendar/push/microsoft`). Nothing to register for that; the
host only has to be reachable from the internet (it is).
