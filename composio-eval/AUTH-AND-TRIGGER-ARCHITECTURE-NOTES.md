# Composio auth model, BubbleLab tool/auth model, and the trigger-coupling problem

Companion to `COMPOSIO-VS-BUBBLELAB-ADVISORY.md` (whether to merge) and `IMPLEMENTATION-GUIDE.md`
(how to merge, credentials and provenance). This note covers three things those two do not: the
exact ownership mechanics of Composio managed auth, code-level examples of both platforms' auth and
tool-wrapping contracts, and a structural finding in BubbleLab that blocks the "make each tool a
standalone workflow, trigger it however you want" goal — a flow's trigger type is a generic type
parameter on the flow class itself, not a separate binding.

Nothing here has been built. BubbleLab code references are from
`/mnt/c/Users/brenn/Documents/on-shot-integration-automation-builder/BubbleLab`, read directly
during this conversation. Composio behavior is drawn from the official docs, linked inline; where
this note's claims overlap with the advisory's live-measured findings (the 122/1,069 managed-auth
count, the callback-URI contradiction), the advisory is the authoritative source — cited, not
re-measured here.

---

## 1. Managed auth: whose account is it?

**The end user's own account. Composio never has a GitHub/Slack/Notion account of its own that
gets used on the user's behalf.**

"Managed" describes who registered the *OAuth application* (the `client_id`/`client_secret` pair a
vendor issues to an app developer), not who owns the account being connected. Standard OAuth2
authorization-code flow has three parties: the resource owner (the end user), the client
application (whoever registered `client_id`/`client_secret` with the vendor), and the vendor
(GitHub, in this example). Composio managed auth changes only the middle party.

**Managed auth (e.g. GitHub):**

1. Composio has already registered an OAuth application with GitHub — Composio's own
   `client_id`/`client_secret`, on file with GitHub, presumably before Composio's own commercial launch.
2. Your app calls `composio.authConfigs.create('github', { type: 'use_composio_managed_auth' })`.
   No credentials passed — Composio already has them.
3. Your end user is redirected to GitHub's own login/consent page (`github.com/login/oauth/authorize`).
   They authenticate as themselves, with their own GitHub credentials.
4. The consent screen shows **Composio's** application identity — "Composio wants to access your
   account" — because Composio is the OAuth client of record, per
   [docs.composio.dev/docs/custom-app-vs-managed-app](https://docs.composio.dev/docs/custom-app-vs-managed-app).
5. The user clicks Authorize. GitHub issues a token scoped to **that user's own GitHub account** —
   their repos, their permissions — bound to Composio's `client_id`.
6. Composio stores that token as a `ConnectedAccount` row keyed to the `user_id` you supplied and
   the toolkit (`github`). Composio refreshes it going forward.

**Custom/BYOC auth (e.g. Notion in the earlier code example):** identical flow, except step 1 is
your own OAuth app (your `client_id`/`client_secret`, your redirect URI) and the consent screen in
step 4 shows your app's name instead of Composio's. The account connected in step 5 is still the
end user's own Notion account — BYOC changes who the OAuth client is, not whose account gets
authorized. That's the whole difference between the two modes.

So: no vendor account belongs to Composio at any point. What Composio owns is the *application
registration* — the thing GitHub or Notion asks "does this app have permission to request access
to a user's account," not "which account is being accessed." A missing detail the marketing docs
don't spell out but that falls straight out of how OAuth2 works, confirmed by the "Composio wants
to access your account" consent-screen wording
([source](https://docs.composio.dev/docs/custom-app-vs-managed-app)) and by connected accounts
being enumerable per `user_id` with multiple simultaneous accounts per toolkit (e.g. personal +
work Gmail) — impossible if a shared Composio account were being reused
([source](https://docs.composio.dev/docs/auth-configuration/connected-accounts)).

One caveat from the advisory, not from Composio's docs: managed auth exists for only 122 of 1,069
toolkits (11%), and 60% of the 202 OAuth-family toolkits. The other 80 OAuth toolkits require you
to register your own app regardless — there is no managed option to fall back to. See
`COMPOSIO-VS-BUBBLELAB-ADVISORY.md` §3.1.

---

## 2. Composio's auth model, in code

Four objects: **Toolkit** (the service, e.g. `github`), **Auth Config** (a blueprint — method,
scopes, managed-vs-custom — one per toolkit per developer), **Connected Account** (one per
authenticated end user, state `INITIATED` → `ACTIVE`), **Entity/User** (your app's `user_id`).

```typescript
// Managed: Composio owns the OAuth app registered with GitHub.
const authConfig = await composio.authConfigs.create('github', {
  type: 'use_composio_managed_auth',
  name: 'GitHub',
});

// Custom/BYOC: the developer's own OAuth app.
const authConfig = await composio.authConfigs.create('notion', {
  type: 'use_custom_auth',
  authScheme: 'OAUTH2',
  name: 'Notion',
  credentials: {
    client_id: process.env.NOTION_CLIENT_ID!,
    client_secret: process.env.NOTION_CLIENT_SECRET!,
    oauth_redirect_uri: 'https://backend.composio.dev/api/v3.1/toolkits/auth/callback',
  },
});

// Bind a specific user to that auth config, then execute tools as them.
const session = await composio.create('user_123', {
  authConfigs: { notion: authConfig.id },
});
```

Credential resolution happens at call time: a tool execution carries `user_id`, Composio looks up
that user's active `ConnectedAccount` for the toolkit, and injects the (refreshed, if needed) token
into the outbound request. Nothing is cached into your application's source or database beyond the
account reference.

Source: [docs.composio.dev/docs/programmatic-auth-configs](https://docs.composio.dev/docs/programmatic-auth-configs),
[docs.composio.dev/docs/authenticating-tools](https://docs.composio.dev/docs/authenticating-tools).

---

## 3. BubbleLab's tool/auth model, in code

Two class hierarchies matter: `ServiceBubble` (wraps one external API, declares `authType`) and
`ToolBubble` (wraps a bubble as an AI-agent-callable tool; itself has no `authType` — it forwards
whatever `credentials` it's given to the service bubble underneath).

**`ServiceBubble` with OAuth** — `packages/bubble-core/src/bubbles/service-bubble/google-sheets/google-sheets.ts`:

```typescript
export class GoogleSheetsBubble<...> extends ServiceBubble<...> {
  static readonly authType = 'oauth' as const;               // line 45

  protected chooseCredential(): string | undefined {          // line 671
    const { credentials } = this.params as { credentials?: Record<string, string> };
    if (!credentials) throw new Error('No Google Sheets credentials provided');
    return credentials[CredentialType.GOOGLE_SHEETS_CRED];
  }

  public async testCredential(): Promise<boolean> {           // line 86
    const credential = this.chooseCredential();
    const response = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(credential)}`
    );
    if (!response.ok) throw new Error(`Google OAuth token validation failed (${response.status})`);
    return true;
  }

  private async makeSheetsApiRequest(...) {                   // line 105
    const requestHeaders = {
      Authorization: `Bearer ${this.chooseCredential()}`,     // line 118
      'Content-Type': 'application/json',
    };
    // ...
  }
}
```

The token itself is minted and refreshed entirely outside the bubble, by
`apps/bubblelab-api/src/services/oauth-service.ts` — its own generic authorization-code
implementation, one per `OAUTH_PROVIDERS` table entry
(`packages/bubble-shared-schemas/src/credential-schema.ts:933`). The bubble only ever sees a plain
access-token string handed to it through `params.credentials`.

**`ToolBubble`** — `packages/bubble-core/src/bubbles/tool-bubble/tool-template.ts`:

```typescript
const MyCustomToolParamsSchema = z.object({
  // ...real params the AI model sees and fills in...
  credentials: z.record(z.nativeEnum(CredentialType), z.string()).optional()
    .describe('Injected at runtime, stripped from the AI-facing schema'),
  config: z.record(z.string(), z.unknown()).optional(),
});

export class MyCustomTool extends ToolBubble<MyCustomToolParams, MyCustomToolResult> {
  static readonly type = 'tool' as const;
  static readonly bubbleName = 'my-custom-tool';
  static readonly schema = MyCustomToolParamsSchema;
  static readonly resultSchema = MyCustomToolResultSchema;
}
```

`ToolBubble.toolAgent()` (`packages/bubble-core/src/types/tool-bubble-class.ts:41-155`) strips
`credentials`/`config` from the schema shown to the model, and returns a closure that merges the
model's call arguments with server-injected credentials before instantiating the bubble and calling
`.action()`. `AIAgentBubble.initializeTools()` (`ai-agent.ts:1273-1305`) is the call site: for each
`customTools` entry it looks up `BUBBLE_CREDENTIAL_OPTIONS[toolName]`
(`credential-schema.ts:2907`), filters the agent's credentials to what that tool accepts, and calls
`toolAgent()`.

**Credential resolution happens at flow-compile time, not call time.** `BubbleInjector`
(`packages/bubble-runtime/src/injection/BubbleInjector.ts:447`) rewrites the parsed flow's source so
`credentials: {...}` is baked into every `new XyzBubble({...})` call before the flow runs. This is
the structural fork against Composio noted in `IMPLEMENTATION-GUIDE.md` §0: Composio resolves a
connected account fresh on every tool call; BubbleLab resolves once, ahead of execution, by
rewriting source. `IMPLEMENTATION-GUIDE.md` §4.1 already proposes the fix — bind a step to a
`connectedAccountId` rather than a secret — which this note's finding reinforces from the tool-bubble
side as well as the credential-model side.

---

## 4. The trigger-coupling problem (new finding — not in the advisory or implementation guide)

Composio decouples *what a tool does* from *what causes it to run*. A **Trigger Instance** is a
subscription on a connected account (`GITHUB_COMMIT_EVENT` on this user's repo), delivered to one
project-wide webhook endpoint you register once; what you do with the event — including whether you
call a tool at all — is your handler's decision, made after the fact:

```typescript
// Subscribe once, project-wide.
await composio.triggers.setWebhookSubscription({ webhookUrl: 'https://your-app.com/webhooks/composio' });

// Create a trigger instance on a specific connected account.
const trigger = await composio.triggers.create(userId, 'GITHUB_COMMIT_EVENT', {
  triggerConfig: { owner: 'your-repo-owner', repo: 'your-repo-name' },
});

// One handler for every trigger type; dispatch is your code, not Composio's.
export async function POST(request: Request) {
  const result = await composio.triggers.parse(request, { verifySecret: process.env.COMPOSIO_WEBHOOK_SECRET });
  if (result.rawPayload.type === 'composio.trigger.message') {
    const event = result.payload;
    if (event.triggerSlug === 'GITHUB_COMMIT_EVENT') { /* ...call whatever tool you want... */ }
  }
  return Response.json({ status: 'ok' });
}
```
([source](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events))

**BubbleLab does not have this separation.** The trigger type is a generic type parameter on the
workflow class itself:

```typescript
// packages/bubble-core/src/bubble-flow/bubble-flow-class.ts:9-44
export abstract class BubbleFlow<TEventType extends keyof BubbleTriggerEventRegistry> {
  readonly cronSchedule?: string;   // required when TEventType is 'schedule/cron'
  abstract handle(payload: BubbleTriggerEventRegistry[TEventType]): Promise<BubbleFlowOperationResult>;
}
```

`BubbleTriggerEventRegistry` (`packages/bubble-shared-schemas/src/trigger.ts:1-32`) is a fixed
9-member union — `slack/bot_mentioned`, `slack/message_received`, `slack/reaction_added`,
`slack/approval_resumed`, `airtable/record_created`, `airtable/record_updated`,
`airtable/record_deleted`, `schedule/cron`, `webhook/http`. A flow declares exactly one member at
class-declaration time (`class Foo extends BubbleFlow<'schedule/cron'>`), and that choice is
persisted again as `bubbleFlow.eventType` in the database. Every dispatch path keys off that single
stored string: `apps/bubblelab-api/src/routes/webhooks.ts:108-166` for webhook/Slack/Airtable,
`apps/bubblelab-api/src/services/cron-scheduler.ts:83-151` for cron. Even the manual "run now"
button doesn't bypass it — `bubble-flows.ts:384-405` synthesizes a fake `webhook/http` payload and
runs the same stored flow.

**Correction to an assumption worth naming precisely:** the coupling is not on `ToolBubble` or
`ServiceBubble` — those are already trigger-agnostic; nothing in `WebSearchTool` or
`GoogleSheetsBubble` mentions cron or webhooks. It's one layer up, on `BubbleFlow`, the deployable
unit an agent's logic gets wrapped in. A tool is reusable across triggers today only by being
called from inside an `AIAgentBubble`'s `customTools`, which itself still has to live inside exactly
one `BubbleFlow<TEventType>`.

### What decoupling requires

Composio's trigger instance is a row independent of the action it eventually causes. BubbleLab
needs the equivalent: pull `TEventType`/`eventType`/`cronSchedule` off `BubbleFlow` itself and
replace it with a separate binding —

```
TriggerBinding: { flowId, kind: 'cron' | 'webhook' | 'manual' | 'agent-call' | ..., config }
```

— so one flow (one unit of tool logic) can carry zero, one, or several trigger bindings, and a
binding can be added or removed without touching the flow's code. This touches four places found
above: the `BubbleFlow` generic itself, the `bubbleFlow.eventType`/`cronSchedule` DB columns, both
dispatch routes (`webhooks.ts`, `cron-scheduler.ts`), and — if Composio triggers are the eventual
event source — a new ingestion endpoint modeled on Composio's single project-wide webhook handler,
since nothing in BubbleLab today accepts an inbound event that isn't already one of the 9 hardcoded
registry members.

This is a design task, not yet scoped into phases the way `IMPLEMENTATION-GUIDE.md` scopes the
credential merge. It should get the same treatment — Phase 0 pilot questions, a seam diagram, an
adoption gate — before code changes.

---

## References

- Managed vs custom auth: https://docs.composio.dev/docs/custom-app-vs-managed-app
- Programmatic auth configs: https://docs.composio.dev/docs/programmatic-auth-configs
- Authenticating tools: https://docs.composio.dev/docs/authenticating-tools
- Connected accounts: https://docs.composio.dev/docs/auth-configuration/connected-accounts
- Creating triggers: https://docs.composio.dev/docs/using-triggers
- Subscribing to trigger events / webhook handler: https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events
- BubbleLab: `packages/bubble-core/src/types/tool-bubble-class.ts`,
  `packages/bubble-core/src/types/service-bubble-class.ts`,
  `packages/bubble-core/src/bubbles/service-bubble/google-sheets/google-sheets.ts`,
  `packages/bubble-core/src/bubbles/tool-bubble/tool-template.ts`,
  `packages/bubble-core/src/bubbles/tool-bubble/web-search-tool.ts`,
  `packages/bubble-core/src/bubble-flow/bubble-flow-class.ts`,
  `packages/bubble-shared-schemas/src/trigger.ts`,
  `packages/bubble-shared-schemas/src/credential-schema.ts`,
  `apps/bubblelab-api/src/services/oauth-service.ts`,
  `apps/bubblelab-api/src/routes/webhooks.ts`,
  `apps/bubblelab-api/src/services/cron-scheduler.ts`,
  `apps/bubblelab-api/src/routes/bubble-flows.ts`
- Related prior research in this directory: `COMPOSIO-VS-BUBBLELAB-ADVISORY.md` (§3.1 managed-auth
  count, §5 surface factors), `IMPLEMENTATION-GUIDE.md` (§4 credential bridging)

