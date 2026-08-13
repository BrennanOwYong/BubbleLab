# Brief: make Google credentials work durably (Google Cloud dashboard)

## Task

Fix two things in the Google Cloud project that owns this app's OAuth client so
that connecting Google (Drive / Sheets / Gmail / Calendar) from the BubbleLab
studio works and the resulting credentials stop dying after 7 days.

You (the executing Claude Code agent) act in the **Google Cloud Console web
dashboard** under the account that owns the project. `gcloud` CLI cannot set OAuth
client redirect URIs or the consent-screen publishing status for a web OAuth
client, so drive the browser at console.cloud.google.com. Sign in as the project
owner if prompted.

## The project and client (exact values)

- Project number: **601986049008**
- OAuth 2.0 Client ID: **601986049008-9tic2s6ba94ln2ti1cn7euf5ov3iolcd.apps.googleusercontent.com**
- Credentials page: https://console.cloud.google.com/apis/credentials?project=601986049008
- Consent screen / Audience: https://console.cloud.google.com/auth/audience?project=601986049008
  (older console: https://console.cloud.google.com/apis/credentials/consent?project=601986049008)

## Why (root causes this fixes)

1. **Callback lands on a dead port.** The API sends Google a `redirect_uri` of
   `http://localhost:3100/oauth/google/callback`. Google only redirects to URIs
   registered on the OAuth client. If `:3100` is not registered, the popup dead-ends.
2. **Credentials die after 7 days.** While the OAuth consent screen's publishing
   status is **Testing**, Google expires every refresh token after 7 days. That is
   why the stored Google Drive credential broke on 2026-07-23 and keeps breaking.
   Publishing the app to **In production** removes the 7-day expiry.

## Task A — Authorized redirect URIs (the PORT RANGE)

On the Credentials page, open the OAuth 2.0 Client ID above → **Authorized
redirect URIs** → add **all** of the entries below (keep any that already
exist), then **Save**. Google allows ~100 redirect URIs, so registering the
whole range is fine and is what lifts the branching gate.

**Why a range, not one port:** `scripts/dev-stack.sh` auto-allocates a free port
trio per branch starting at `PORT_BASE=3100` (API = first free ≥3100, then
sidecar, then studio). So parallel branches land API ports around 3100, 3103,
3106… — none of which OAuth works on unless that exact port's callback is
registered. Registering `3100..3130` covers ~10 parallel stacks. (`dev-stack.sh`
already exports `NODEX_API_URL`/`DASHBOARD_URL` per stack — the code half is
done; this registration is the remaining half.)

Add every port from **3100 to 3130** in this form:

```
http://localhost:3100/oauth/google/callback
http://localhost:3101/oauth/google/callback
http://localhost:3102/oauth/google/callback
http://localhost:3103/oauth/google/callback
http://localhost:3104/oauth/google/callback
http://localhost:3105/oauth/google/callback
http://localhost:3106/oauth/google/callback
http://localhost:3107/oauth/google/callback
http://localhost:3108/oauth/google/callback
http://localhost:3109/oauth/google/callback
http://localhost:3110/oauth/google/callback
http://localhost:3111/oauth/google/callback
http://localhost:3112/oauth/google/callback
http://localhost:3113/oauth/google/callback
http://localhost:3114/oauth/google/callback
http://localhost:3115/oauth/google/callback
http://localhost:3116/oauth/google/callback
http://localhost:3117/oauth/google/callback
http://localhost:3118/oauth/google/callback
http://localhost:3119/oauth/google/callback
http://localhost:3120/oauth/google/callback
http://localhost:3121/oauth/google/callback
http://localhost:3122/oauth/google/callback
http://localhost:3123/oauth/google/callback
http://localhost:3124/oauth/google/callback
http://localhost:3125/oauth/google/callback
http://localhost:3126/oauth/google/callback
http://localhost:3127/oauth/google/callback
http://localhost:3128/oauth/google/callback
http://localhost:3129/oauth/google/callback
http://localhost:3130/oauth/google/callback
```

Also keep the two legacy ports so an older stack still works:

```
http://localhost:3001/oauth/google/callback
http://localhost:3000/oauth/google/callback
```

Minimum if you only run one stack: `:3100` (the current API). The full range is
what makes parallel-branch testing work and lifts the F0.3 branching gate.

## Task B — Publish the consent screen (Testing → In production)

On the Audience / consent screen page, if **Publishing status** is _Testing_,
click **Publish app** and confirm → status becomes **In production**.

- This is the fix for the 7-day credential death.
- The app uses restricted/sensitive scopes (gmail.\*, drive.readonly), so an
  unverified production app shows an "unverified app" warning and is capped at 100
  users. That is fine here — the developer's own account still gets a
  **non-expiring** refresh token, which is the whole point. Do NOT start Google's
  formal verification; just publish.
- If publishing is blocked outright by the restricted scopes, fall back: keep
  status _Testing_ but ensure **brennanowyong@gmail.com** is listed under **Test
  users**. (This restores connectivity but the 7-day expiry returns — note it in
  your report so the human knows the credential must be re-consented weekly.)

## Task C — Confirm scopes are registered

On the consent screen's **Data access / Scopes**, confirm these are present (add
any missing, then Save). The app requests them across its Google bubbles:

```
openid
email
profile
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.send
```

For the immediate demo only `drive.file` and `spreadsheets` are exercised; the
rest keep the other flows working.

## Verify before reporting done

1. Credentials page → the OAuth client lists all three redirect URIs.
2. Consent screen → Publishing status reads **In production** (or Test users
   includes brennanowyong@gmail.com if you took the fallback).
3. Scopes list includes at least `openid email drive.file spreadsheets`.

## Report back

- Publishing status now in effect (In production / Testing+testuser).
- The exact redirect URIs saved on the client.
- Any scope you had to add.
- Whether publishing hit a restricted-scope block (and which scope).

## References

- Redirect URI rules: https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred
- 7-day refresh-token expiry in Testing: https://developers.google.com/identity/protocols/oauth2#expiration
- Publishing status: https://support.google.com/cloud/answer/10311615
