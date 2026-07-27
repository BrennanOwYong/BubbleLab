/**
 * Field-descriptor contract shared between the setup/default-value form and
 * the in-conversation "needs info" form.
 *
 * The generate route (codegen lane) emits fields as:
 *   { key, header, hint, value? }
 * - `header` renders as the field LABEL.
 * - `value`, when present, renders as REAL editable input text (the input's
 *   `value`, normal text color). A known value is never shown as placeholder:
 *   greyed placeholder text makes users believe the value was not received.
 * - `hint` renders as the placeholder ONLY when no value exists yet.
 */

export interface FieldDescriptor {
  /** Payload key the value is stored under (e.g. `telegramChatId`) */
  key: string;
  /** Plain-language label shown above the input */
  header: string;
  /** Non-technical hint shown as placeholder while the field has no value */
  hint: string;
  /** Known value (user-provided, auto-provisioned, or profile default) */
  value?: string;
}

/** Runtime guard for one descriptor coming out of persisted metadata. */
export function isFieldDescriptor(entry: unknown): entry is FieldDescriptor {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.key === 'string' &&
    typeof candidate.header === 'string' &&
    typeof candidate.hint === 'string' &&
    (candidate.value === undefined || typeof candidate.value === 'string')
  );
}

/**
 * `notionDatabaseId` -> `Notion database ID`. Labels for fields that arrive
 * without a `header` (plain inputSchema fields).
 */
export function humanizeFieldName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((word) => (word === 'id' ? 'ID' : word === 'url' ? 'link' : word));
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The single value-vs-placeholder rule (C1). A field that HAS a known value
 * shows it as the input's real `value`; the hint is the placeholder only when
 * no value exists. `storedValue === ''` means the user cleared the field, so
 * the hint placeholder shows again (the empty string stays the value).
 */
export function resolveFieldText(options: {
  /** The live edited value (execution inputs / form state), if any */
  storedValue: unknown;
  /** Known value carried on the field itself (descriptor value / schema default) */
  knownValue?: unknown;
  /** Non-technical hint for the empty state */
  hint?: string;
  /** Field key, for the fallback hint */
  name: string;
}): { displayValue: string; placeholder: string } {
  const { storedValue, knownValue, hint, name } = options;
  const display =
    typeof storedValue === 'string' || typeof storedValue === 'number'
      ? String(storedValue)
      : knownValue !== undefined && knownValue !== null
        ? String(knownValue)
        : '';
  return {
    displayValue: display,
    placeholder: hint || `Enter ${humanizeFieldName(name).toLowerCase()}...`,
  };
}

/**
 * `userProfileDefaults` rides GET /bubble-flow/:id when the profile lane has
 * landed; today it may be absent — this narrows it without any cast to `any`.
 * Expected shape: a map of profile keys (e.g. `recipientEmail`,
 * `telegramChatId`) to default values.
 */
export function getUserProfileDefaults(
  flow: unknown
): Record<string, string> | undefined {
  if (typeof flow !== 'object' || flow === null) return undefined;
  const raw = (flow as { userProfileDefaults?: unknown }).userProfileDefaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const defaults: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) {
      defaults[key] = value;
    }
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

/** `telegram-chat-id` / `telegramChatId` -> `telegramchatid` for matching */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Profile default for one input field. Matches the field name against the
 * profile map by exact key first, then normalized key, then the two semantic
 * groups the profile carries today:
 * - recipient-email keys (`recipientEmail`, `email`) -> fields naming an email
 * - telegram-chat-id keys (`telegramChatId`, `chatId`) -> fields naming a chat id
 */
export function matchProfileDefault(
  fieldName: string,
  profileDefaults: Record<string, string> | undefined
): string | undefined {
  if (!profileDefaults) return undefined;
  if (profileDefaults[fieldName] !== undefined) {
    return profileDefaults[fieldName];
  }
  const normalizedField = normalizeKey(fieldName);
  for (const [key, value] of Object.entries(profileDefaults)) {
    if (normalizeKey(key) === normalizedField) return value;
  }
  const fieldIsEmail = /email/i.test(fieldName);
  const fieldIsChatId = /chat.?id/i.test(fieldName);
  for (const [key, value] of Object.entries(profileDefaults)) {
    const normalizedKey = normalizeKey(key);
    if (fieldIsEmail && /email/.test(normalizedKey)) return value;
    if (fieldIsChatId && /chatid/.test(normalizedKey)) return value;
  }
  return undefined;
}

/**
 * Seed map for execution inputs: profile defaults mapped onto the flow's
 * inputSchema field names, overlaid by the flow's saved defaultInputs (saved
 * values always win over profile defaults).
 */
export function applyProfileDefaults(
  inputSchema: unknown,
  defaultInputs: Record<string, unknown>,
  profileDefaults: Record<string, string> | undefined
): Record<string, unknown> {
  if (!profileDefaults) return defaultInputs;
  const properties =
    typeof inputSchema === 'object' &&
    inputSchema !== null &&
    typeof (inputSchema as { properties?: unknown }).properties === 'object' &&
    (inputSchema as { properties?: unknown }).properties !== null
      ? ((inputSchema as { properties: Record<string, unknown> })
          .properties as Record<string, unknown>)
      : {};
  const seeded: Record<string, unknown> = {};
  for (const fieldName of Object.keys(properties)) {
    const profileValue = matchProfileDefault(fieldName, profileDefaults);
    if (profileValue !== undefined) seeded[fieldName] = profileValue;
  }
  return { ...seeded, ...defaultInputs };
}
