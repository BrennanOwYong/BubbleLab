# Gmail backfill — result

## Status

DONE. All four fixes verified against source and official docs; two implemented as new capability, one implemented as a bug fix, one half-skipped (already present).

## Branch / commit / push

- Branch: `feature/gmail-backfill` (based on `feature/mvp-oneshot` tip 4c3a683)
- Commit: see `git log -1` on the branch (message: "backfill: gmail get_thread + attachments + RFC 2822 threading + search pagination")
- Pushed: `origin feature/gmail-backfill`

## Files changed

- `packages/bubble-core/src/bubbles/service-bubble/gmail.ts` — all four fixes
- `packages/bubble-core/src/bubbles/service-bubble/gmail.metadata.ts` — `get_thread` operation metadata (read, idempotent, scopes, citation)
- `packages/bubble-core/src/bubbles/service-bubble/gmail-backfill.test.ts` — 8 new unit tests (NEW)

## Gmail API doc URLs relied on

- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get — GET /users/{userId}/threads/{id}, format=full "returns the full email message data with body content parsed in the payload field"
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get — GET /users/{userId}/messages/{messageId}/attachments/{id} → MessagePartBody (base64url data)
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages — Message.threadId criteria: "(1) threadId specified, (2) References and In-Reply-To headers must be set in compliance with the RFC 2822 standard, (3) Subject headers must match"
- https://developers.google.com/workspace/gmail/api/guides/sending — multipart MIME with attachments, base64url `raw` field, threading requirements
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list — pageToken query param, nextPageToken response field

The doc URLs are also cited in code comments at the implementing sites (gmail.ts `getThread`, `createEmailMessage`) and in gmail.metadata.ts.

## Fix-by-fix

### 1. get_thread — DONE (was the hard block)

Confirmed missing: only `list_threads` existed (users.threads.list → id/snippet/historyId stubs, no messages). Added `get_thread` operation → `GET /users/me/threads/{thread_id}?format=full` (users.threads.get; format/metadata_headers params supported). Each returned message runs through the existing `processAndCleanMessage` path: body decoded into `textContent`, headers filtered to essentials (Subject/From/To/Message-ID/References/...), base64 payload data stripped. Result shape: `{ thread: { id, historyId, snippet, messages: [...] } }`. Unblocks Gi Hoon's deal-stage updater (read full thread content).

### 2. Attachments — HALF SKIPPED / HALF DONE

- Download: `get_attachment` (users.messages.attachments.get, messageId+attachmentId → base64url data converted to padded standard base64) ALREADY EXISTED at gmail.ts `getAttachment`. Audit stale on this half; skipped, but covered with a new call-shape unit test.
- Send with attachments: was missing (`createEmailMessage` built only multipart/alternative). Added `attachments: [{filename, mime_type, data}]` to `send_email` and `create_draft`. Builds multipart/mixed MIME: body part (single or nested multipart/alternative) + one part per file with `Content-Disposition: attachment`, `Content-Transfer-Encoding: base64`, data normalized (base64url→base64, padded, 76-char wrapped per RFC 2045). Sent through the existing JSON `raw` path on POST /messages/send — the approach the sending guide documents. Filenames RFC 2047-encoded when non-ASCII. Covers Alex invoice PDFs / Thea reports.
- Limitation noted: JSON `raw` inflates payload ~4/3; attachments beyond a few MB should move to the `/upload/gmail/v1/.../messages/send` media endpoint (uploadType=multipart, message/rfc822). Recorded as follow-on; not needed for invoice/report-sized files.

### 3. RFC 2822 threading headers — DONE (bug fix, worse than "missing")

Existing code wrote the Gmail `thread_id` (an API hex id) into `In-Reply-To`/`References` (old gmail.ts:1215-1218). That violates RFC 2822 (headers must carry Message-IDs in angle brackets) and per the Message resource docs breaks the documented threading criteria — replies arrive as new conversations (Joran follow-ups). Fix:

- New `in_reply_to` / `references` params on `send_email` + `create_draft`; angle brackets added when missing.
- Auto-resolution: when `thread_id` is set without `in_reply_to`, the bubble fetches `/threads/{id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`, takes the last message's Message-ID → `In-Reply-To`, and its References + that id → `References` (RFC 2822 §3.6.4 chain). Existing flows that pass only `thread_id` now thread correctly with zero param changes.
- Lookup failure degrades: send proceeds with `threadId` only (never blocks the send).
- The bogus thread_id-as-Message-ID emission is removed.

### 4. Search pagination — DONE

`search_emails` had no `page_token` param and returned no `next_page_token` (list_emails/list_drafts/list_threads already had both). Added `page_token` → `pageToken` query param and `next_page_token` ← `nextPageToken` in the result schema. Multi-page result sets now reachable.

## Unit tests (gmail-backfill.test.ts, mocked fetch — no real Gmail API)

8 tests, all passing:

1. get_thread calls `/users/me/threads/{id}?format=full` GET with Bearer auth; returns 2 messages with decoded `textContent`; noise headers dropped; base64 body stripped
2. get_thread passes format=metadata + metadataHeaders through
3. get_attachment calls `/users/me/messages/{mid}/attachments/{aid}`; base64url→padded base64 round-trips
4. send_email + attachments builds multipart/mixed with Content-Disposition/base64 part and body text
5. explicit in_reply_to → bracketed In-Reply-To/References, no extra API call, threadId in request body, thread id never used as header value
6. thread_id only → auto-resolve lookup (format=metadata, Message-ID+References) then send with derived References chain
7. thread lookup 500 → send still succeeds with threadId, no In-Reply-To emitted
8. search_emails sends pageToken and returns next_page_token

## Test/build results

- New gmail tests: 8/8 pass (plus existing gmail-encoding: 6/6)
- Full bubble-core suite (`pnpm --filter @bubblelab/bubble-core test`): 42 files passed, **616 passed / 2 skipped / 0 failed**
- `tsc --noEmit` bubble-core: clean
- bubble-core build (tsc + bubble-bundler + metadata-bundler): clean; regenerated `dist/bubbles.json` (94 bubbles) verified to contain `get_thread`, `in_reply_to`, `references`, `attachments`, `page_token`, `next_page_token`
- bubble-runtime build (tsc): clean
- credential-schema.ts: untouched (GMAIL_CRED reused)

## Follow-on: users.watch push trigger (NOT built, by brief)

Real-time Gmail push (users.watch → Cloud Pub/Sub → webhook) requires extending the CLOSED trigger registry (`BUBBLE_TRIGGER_EVENTS` in `bubble-shared-schemas/src/trigger.ts`) plus a Pub/Sub topic + grant to `gmail-api-push@system.gserviceaccount.com` and a watch-renewal cron (watches expire after 7 days). Separate architectural change. Payoff: converts Gi Hoon lead-intake, Tracy chargeback, and Karsten intake flows from cron-polling to event triggers. Doc: https://developers.google.com/workspace/gmail/api/guides/push
Second smaller follow-on: media-upload endpoint for very large attachments (see fix 2).

## Deviations

- get_attachment half of fix 2 skipped: already implemented on the base branch; audit stale. Verified against source and covered with a call-shape test instead.
- Fix 3 delivered as a bug fix rather than an addition: the existing header emission was wrong (thread id as Message-ID), so the broken behavior was removed, and auto-resolution was added so existing thread_id-only callers benefit without param changes.

## Learnings

- Gmail threading contract (Message resource docs): threadId alone is not enough — References/In-Reply-To must be RFC 2822-compliant AND Subject must match, or replies split into new conversations.
- threads.list vs threads.get: list returns message-less stubs by design; full thread content only via threads.get (format=full). No format param on list changes this.
- `users.drafts.send` is POST /drafts/send with `{id}` in the body (no /drafts/{id}/send route) — pre-existing comment in gmail.ts, confirmed still correct.
- The bubble manifest (dist/bubbles.json) regenerates from the Zod schemas during `pnpm --filter @bubblelab/bubble-core build`; no hand-maintained statics for gmail params. Manifest top-level shape is `{version, generatedAt, totalCount, bubbles}`.
- gmail.metadata.ts is generated by scripts/backfill-operation-metadata.ts but safe to hand-extend when the new entry carries its own doc citation (file header requires citation-grounded classifications).
