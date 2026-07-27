/**
 * User-profile defaults for flow "for me" input fields, server-side.
 *
 * The flow creator's OWN recipient email and Telegram chat id live in the
 * user_profiles table (outside credentials — personal facts, not secrets).
 * A flow input asking "who should receive this" (recipientEmail, chat_id, …)
 * should prefill to those stored values so "send it to me" works without the
 * user hunting for their own chat id.
 *
 * Matching: an input-schema property key is normalized (lowercased,
 * `_`/`-` stripped) and looked up against a fixed alias set per profile
 * field. The returned map is keyed by the EXACT (unnormalized) inputSchema
 * property name, value = the stored profile string. An entry exists only
 * when the key matches AND the profile value is set.
 *
 * The map rides the GET /bubble-flow/:id response as `userProfileDefaults`
 * next to `accountEmailDefaults` (see bubbleFlowDetailsResponseSchema); the
 * studio prefills by field key. Mirrors resolveAccountEmailDefaults.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userProfiles } from '../db/schema.js';

/** Normalized field-name aliases that mean "the creator's own recipient email". */
const RECIPIENT_EMAIL_ALIASES = new Set([
  'recipientemail',
  'recipientemailaddress',
  'toemail',
  'email',
  'emailaddress',
  'recipient',
  'useremail',
  'myemail',
  'targetemail',
  'destinationemail',
  'sendto',
]);

/** Normalized field-name aliases that mean "the creator's own Telegram chat id". */
const TELEGRAM_CHAT_ID_ALIASES = new Set([
  'chatid',
  'telegramchatid',
  'telegramchat',
  'tochatid',
  'targetchatid',
  'mychatid',
]);

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/** Extract the property names of a flow's payload JSON schema, defensively. */
function extractInputFieldKeys(inputSchema: unknown): string[] {
  if (typeof inputSchema !== 'object' || inputSchema === null) return [];
  const properties = (inputSchema as Record<string, unknown>).properties;
  if (typeof properties !== 'object' || properties === null) return [];
  return Object.keys(properties);
}

/**
 * Resolve, per "for me" input field of a flow, the profile value it should
 * prefill to. `requiredInputs` is the flow's payload JSON schema
 * (`bubble_flows.input_schema`: `{ type, properties, required }`).
 * Returns `{ <exact inputSchema property name>: <stored profile value> }`;
 * empty when the user has no profile row, no profile value is set, or no
 * input field matches.
 */
export async function resolveUserProfileDefaults(
  userId: string,
  requiredInputs: unknown
): Promise<Record<string, string>> {
  const fieldKeys = extractInputFieldKeys(requiredInputs);
  if (fieldKeys.length === 0) return {};

  const relevant = fieldKeys.filter((key) => {
    const normalized = normalizeFieldKey(key);
    return (
      RECIPIENT_EMAIL_ALIASES.has(normalized) ||
      TELEGRAM_CHAT_ID_ALIASES.has(normalized)
    );
  });
  if (relevant.length === 0) return {};

  const [profile] = await db
    .select({
      recipientEmail: userProfiles.recipientEmail,
      telegramChatId: userProfiles.telegramChatId,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  if (!profile) return {};

  const defaults: Record<string, string> = {};
  for (const key of relevant) {
    const normalized = normalizeFieldKey(key);
    if (RECIPIENT_EMAIL_ALIASES.has(normalized) && profile.recipientEmail) {
      defaults[key] = profile.recipientEmail;
    } else if (
      TELEGRAM_CHAT_ID_ALIASES.has(normalized) &&
      profile.telegramChatId
    ) {
      defaults[key] = profile.telegramChatId;
    }
  }
  return defaults;
}
