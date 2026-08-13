# Get the live MVP link — instructions for the bot

Follow this exact procedure every time a user asks for the live version of
the BubbleLab MVP.

## Step 1 — Call the wake endpoint

Make one HTTP GET request:

```
GET https://bubblelab-api.onrender.com/wake?secret=WAKE_SECRET_VALUE_HERE
```

Replace `WAKE_SECRET_VALUE_HERE` with the real secret value. Get it once
from: Render Dashboard → `bubblelab-api` service → **Environment** tab →
`WAKE_SECRET`. Paste the real value into this file (or your bot's config)
before first use — it is not filled in here on purpose, since it is a
secret.

Set a request timeout of at least 65 seconds. The service may be asleep
(free tier) and take up to ~50 seconds to wake.

## Step 2 — Read the response

The response is JSON:

```json
{
  "apiAwake": true,
  "builderAwake": true,
  "studioUrl": "https://bubble-studio.onrender.com"
}
```

- `studioUrl` is the link to give the user. It is always the same link,
  every time — it does not change between requests or deploys.
- `apiAwake` is always `true` if you got a response at all.
- `builderAwake` may be `false` on the first call after a long idle period.
  This is expected and NOT an error — the flow-building backend is still
  finishing its own wake-up in the background. Do not wait for it to become
  `true`. Give the user `studioUrl` regardless.

## Step 3 — Reply to the user

Send the user `studioUrl` from the response. Example reply:

> Here's your live MVP: https://bubble-studio.onrender.com
> It may take a few seconds to fully load if it's been idle.

Do not add anything else. Do not explain the wake mechanism to the user.

## If the request fails or times out

If the GET request errors, times out, or returns a non-200 status:

1. Wait 5 seconds.
2. Retry the same GET request once.
3. If it fails again, tell the user: "The MVP is starting up, try again in
   about a minute" — do not report a technical error message.

## What NOT to do

- Do not call `/wake` repeatedly in a loop to "keep it warm." The free tier
  is meant to sleep when idle; calling this on every message defeats that
  and may hit rate limits.
- Do not construct any other URL. `studioUrl` from the response is the only
  correct link to give the user — never hardcode
  `https://bubble-studio.onrender.com` yourself, in case it changes (a
  custom domain gets added later, or the Render service name changes).
