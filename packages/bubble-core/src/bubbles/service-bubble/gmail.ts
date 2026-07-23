import { z } from 'zod';
import { ServiceBubble } from '../../types/service-bubble-class.js';
import { GMAIL_OPERATION_METADATA } from './gmail.metadata.js';
import type { BubbleContext } from '../../types/bubble.js';
import { CredentialType } from '@bubblelab/shared-schemas';
import { markdownToHtml } from '../../utils/markdown-to-html.js';

/**
 * RFC 2047 encode a header value if it contains non-ASCII characters.
 * Email headers are assumed Latin-1 unless explicitly encoded, so any
 * non-ASCII content (emojis, accented chars, CJK, etc.) must be wrapped
 * in =?UTF-8?B?<base64>?= to be displayed correctly by mail clients.
 */
function encodeRFC2047(str: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally matching full ASCII range (0x00-0x7F)
  if (!str || /^[\x00-\x7f]*$/.test(str)) return str;
  const encoded = Buffer.from(str, 'utf-8').toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

/**
 * Wrap an RFC 2822 Message-ID value in angle brackets when they are missing.
 * Gmail threads replies across mail clients via In-Reply-To/References, and
 * both headers require bracketed Message-ID values.
 */
function ensureAngleBrackets(messageId: string): string {
  const trimmed = messageId.trim();
  if (!trimmed) return trimmed;
  const withOpen = trimmed.startsWith('<') ? trimmed : `<${trimmed}`;
  return withOpen.endsWith('>') ? withOpen : `${withOpen}>`;
}

/**
 * Normalize base64 or base64url input to standard padded base64, wrapped at
 * 76 characters per line as required for a Content-Transfer-Encoding: base64
 * MIME body (RFC 2045 section 6.8).
 */
function normalizeBase64ForMime(data: string): string {
  const standard = data
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return padded.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

// Essential headers that users typically care about
const ESSENTIAL_HEADERS = [
  'Subject',
  'From',
  'To',
  'Cc',
  'Bcc',
  'Date',
  'Reply-To',
  'Message-ID',
  'In-Reply-To',
  'References',
] as const;

// Define email header schema
const EmailHeaderSchema = z
  .object({
    name: z.string().describe('Header name (e.g., "Subject", "From", "To")'),
    value: z.string().describe('Header value'),
  })
  .describe('Email header key-value pair');

// Define outgoing attachment schema
const EmailAttachmentSchema = z
  .object({
    filename: z
      .string()
      .min(1, 'Attachment filename is required')
      .describe('File name shown to the recipient (e.g., "invoice.pdf")'),
    mime_type: z
      .string()
      .min(1, 'Attachment MIME type is required')
      .describe('MIME type of the file (e.g., "application/pdf")'),
    data: z
      .string()
      .min(1, 'Attachment data is required')
      .describe('File content encoded as base64 or base64url'),
  })
  .describe('File attachment for an outgoing email');

// Define email message schema
const GmailMessageSchema = z
  .object({
    id: z.string().describe('Unique message identifier'),
    threadId: z
      .string()
      .optional()
      .describe('Thread identifier this message belongs to'),
    labelIds: z
      .array(z.string())
      .optional()
      .describe('List of label IDs applied to this message'),
    snippet: z
      .string()
      .optional()
      .describe('Short snippet of the message text'),
    textContent: z
      .string()
      .optional()
      .describe('Clean, readable email text content'),
    historyId: z
      .string()
      .optional()
      .describe('History record ID that last modified this message'),
    internalDate: z
      .string()
      .optional()
      .describe('Internal message creation timestamp (epoch ms)'),
    sizeEstimate: z.number().optional().describe('Estimated size in bytes'),
    raw: z
      .string()
      .optional()
      .describe('Entire email message in RFC 2822 format (base64url encoded)'),
    payload: z
      .object({
        mimeType: z
          .string()
          .optional()
          .describe('MIME type of the email content'),
        headers: z
          .array(EmailHeaderSchema)
          .optional()
          .describe(
            'Essential email headers only (Subject, From, To, Cc, Bcc, Date, Reply-To, Message-ID, In-Reply-To, References)'
          ),
        body: z
          .object({
            data: z
              .string()
              .optional()
              .describe('Email body content (base64url encoded)'),
            size: z
              .number()
              .optional()
              .describe('Size of the body content in bytes'),
            attachmentId: z
              .string()
              .optional()
              .describe(
                'ID of the attachment if this body part is an attachment'
              ),
          })
          .optional()
          .describe('Email body content and metadata'),
        parts: z
          .array(z.any())
          .optional()
          .describe('Array of message parts for multipart emails'),
      })
      .optional()
      .describe('Parsed email structure'),
  })
  .describe('Gmail message object');

// Define draft schema
const GmailDraftSchema = z
  .object({
    id: z.string().describe('Unique draft identifier'),
    message: GmailMessageSchema.describe('Draft message content'),
  })
  .describe('Gmail draft object');

// Define thread schema
const GmailThreadSchema = z
  .object({
    id: z.string().describe('Unique thread identifier'),
    historyId: z.string().optional().describe('Last history record ID'),
    messages: z
      .array(GmailMessageSchema)
      .optional()
      .describe('Messages in this thread'),
    snippet: z.string().optional().describe('Thread snippet'),
  })
  .describe('Gmail thread object');

// Define label schema
const GmailLabelSchema = z
  .object({
    id: z.string().describe('Label ID'),
    name: z.string().describe('Label name'),
    type: z
      .enum(['system', 'user'])
      .optional()
      .describe('Label type: system (built-in) or user (custom)'),
    messageListVisibility: z
      .enum(['show', 'hide'])
      .optional()
      .describe('Visibility in message list'),
    labelListVisibility: z
      .enum(['labelShow', 'labelShowIfUnread', 'labelHide'])
      .optional()
      .describe('Visibility in label list'),
  })
  .describe('Gmail label object');

// Define the parameters schema for Gmail operations
const GmailParamsSchema = z.discriminatedUnion('operation', [
  // Send email operation
  z.object({
    operation: z.literal('send_email').describe('Send an email message'),
    to: z
      .array(z.string().email())
      .min(1, 'At least one recipient is required')
      .describe('List of recipient email addresses'),
    cc: z
      .array(z.string().email())
      .optional()
      .describe('List of CC recipient email addresses'),
    bcc: z
      .array(z.string().email())
      .optional()
      .describe('List of BCC recipient email addresses'),
    subject: z
      .string()
      .min(1, 'Subject is required')
      .describe('Email subject line'),
    body_text: z
      .string()
      .optional()
      .describe(
        '[ONEOF:body] Email body (supports markdown — automatically converted to HTML for rendering)'
      ),
    body_html: z
      .string()
      .optional()
      .describe(
        '[ONEOF:body] HTML email body. If not provided and body_text is set, HTML is auto-generated from body_text.'
      ),
    reply_to: z.string().email().optional().describe('Reply-to email address'),
    thread_id: z
      .string()
      .optional()
      .describe(
        'Gmail thread ID to reply into. Threading headers (In-Reply-To/References) are auto-resolved from the thread when in_reply_to is not set.'
      ),
    in_reply_to: z
      .string()
      .optional()
      .describe(
        'RFC 2822 Message-ID of the message being replied to (e.g., "<abc@mail.gmail.com>"). Auto-resolved from thread_id when omitted.'
      ),
    references: z
      .string()
      .optional()
      .describe(
        'RFC 2822 References header value (space-separated Message-IDs). Auto-resolved from thread_id when omitted.'
      ),
    attachments: z
      .array(EmailAttachmentSchema)
      .optional()
      .describe(
        'Files to attach (sent as multipart/mixed MIME parts; keep total size under the ~35 MB Gmail message limit)'
      ),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // List emails operation
  z.object({
    operation: z
      .literal('list_emails')
      .describe('List emails in the user mailbox'),
    query: z
      .string()
      .optional()
      .describe('Gmail search query (e.g., "from:user@example.com is:unread")'),
    label_ids: z
      .array(z.string())
      .optional()
      .describe('Filter by specific label IDs'),
    include_spam_trash: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include messages from SPAM and TRASH'),
    max_results: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe('Maximum number of messages to return'),
    page_token: z
      .string()
      .optional()
      .describe('Token for pagination to get next page'),
    include_details: z
      .boolean()
      .default(true)
      .describe(
        'Whether to fetch full message details including snippet, headers, and body'
      ),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Get email operation
  z.object({
    operation: z.literal('get_email').describe('Get a specific email message'),
    message_id: z
      .string()
      .min(1, 'Message ID is required')
      .describe('Gmail message ID to retrieve'),
    format: z
      .enum(['minimal', 'full', 'raw', 'metadata'])
      .optional()
      .default('full')
      .describe('Format to return the message in'),
    metadata_headers: z
      .array(z.string())
      .optional()
      .describe('List of headers to include when format is metadata'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Search emails operation
  z.object({
    operation: z.literal('search_emails').describe('Search emails with query'),
    query: z
      .string()
      .min(1, 'Search query is required')
      .describe('Gmail search query string'),
    max_results: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .default(50)
      .describe('Maximum number of results to return'),
    page_token: z
      .string()
      .optional()
      .describe(
        'Token for pagination to get the next page (next_page_token from a prior search)'
      ),
    include_spam_trash: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include messages from SPAM and TRASH'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Mark as read operation
  z.object({
    operation: z
      .literal('mark_as_read')
      .describe('Mark one or more messages as read'),
    message_ids: z
      .array(z.string())
      .min(1, 'At least one message ID is required')
      .describe('List of message IDs to mark as read'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Mark as unread operation
  z.object({
    operation: z
      .literal('mark_as_unread')
      .describe('Mark one or more messages as unread'),
    message_ids: z
      .array(z.string())
      .min(1, 'At least one message ID is required')
      .describe('List of message IDs to mark as unread'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Create draft operation
  z.object({
    operation: z.literal('create_draft').describe('Create a draft email'),
    to: z
      .array(z.string().email())
      .min(1, 'At least one recipient is required')
      .describe('List of recipient email addresses'),
    cc: z
      .array(z.string().email())
      .optional()
      .describe('List of CC recipient email addresses'),
    bcc: z
      .array(z.string().email())
      .optional()
      .describe('List of BCC recipient email addresses'),
    subject: z
      .string()
      .min(1, 'Subject is required')
      .describe('Email subject line'),
    body_text: z
      .string()
      .optional()
      .describe(
        '[ONEOF:body] Email body (supports markdown — automatically converted to HTML for rendering)'
      ),
    body_html: z
      .string()
      .optional()
      .describe(
        '[ONEOF:body] HTML email body. If not provided and body_text is set, HTML is auto-generated from body_text.'
      ),
    reply_to: z.string().email().optional().describe('Reply-to email address'),
    thread_id: z
      .string()
      .optional()
      .describe(
        'Gmail thread ID to reply into. Threading headers (In-Reply-To/References) are auto-resolved from the thread when in_reply_to is not set.'
      ),
    in_reply_to: z
      .string()
      .optional()
      .describe(
        'RFC 2822 Message-ID of the message being replied to (e.g., "<abc@mail.gmail.com>"). Auto-resolved from thread_id when omitted.'
      ),
    references: z
      .string()
      .optional()
      .describe(
        'RFC 2822 References header value (space-separated Message-IDs). Auto-resolved from thread_id when omitted.'
      ),
    attachments: z
      .array(EmailAttachmentSchema)
      .optional()
      .describe(
        'Files to attach (sent as multipart/mixed MIME parts; keep total size under the ~35 MB Gmail message limit)'
      ),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Send draft operation
  z.object({
    operation: z.literal('send_draft').describe('Send a draft email'),
    draft_id: z
      .string()
      .min(1, 'Draft ID is required')
      .describe('Gmail draft ID to send'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // List drafts operation
  z.object({
    operation: z.literal('list_drafts').describe('List draft emails'),
    query: z.string().optional().describe('Search query to filter drafts'),
    max_results: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe('Maximum number of drafts to return'),
    page_token: z
      .string()
      .optional()
      .describe('Token for pagination to get next page'),
    include_spam_trash: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include drafts from SPAM and TRASH'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Delete email operation
  z.object({
    operation: z
      .literal('delete_email')
      .describe('Delete an email message permanently'),
    message_id: z
      .string()
      .min(1, 'Message ID is required')
      .describe('Gmail message ID to delete'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Trash email operation
  z.object({
    operation: z
      .literal('trash_email')
      .describe('Move an email message to trash'),
    message_id: z
      .string()
      .min(1, 'Message ID is required')
      .describe('Gmail message ID to move to trash'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // List threads operation
  z.object({
    operation: z.literal('list_threads').describe('List email threads'),
    query: z
      .string()
      .optional()
      .describe('Gmail search query to filter threads'),
    label_ids: z
      .array(z.string())
      .optional()
      .describe('Filter by specific label IDs'),
    include_spam_trash: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include threads from SPAM and TRASH'),
    max_results: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe('Maximum number of threads to return'),
    page_token: z
      .string()
      .optional()
      .describe('Token for pagination to get next page'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Get thread operation
  z.object({
    operation: z
      .literal('get_thread')
      .describe(
        'Get a full email thread with all of its messages (headers and decoded body text)'
      ),
    thread_id: z
      .string()
      .min(1, 'Thread ID is required')
      .describe(
        'Gmail thread ID to retrieve (from list_threads or a message threadId)'
      ),
    format: z
      .enum(['minimal', 'full', 'metadata'])
      .optional()
      .default('full')
      .describe(
        'Format for the thread messages: full (parsed body content), metadata (IDs, labels, headers), minimal (IDs and labels only)'
      ),
    metadata_headers: z
      .array(z.string())
      .optional()
      .describe('List of headers to include when format is metadata'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // List labels operation
  z.object({
    operation: z.literal('list_labels').describe('List all labels in mailbox'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Create label operation
  z.object({
    operation: z.literal('create_label').describe('Create a new custom label'),
    name: z
      .string()
      .min(1, 'Label name is required')
      .describe('Label name (display name)'),
    label_list_visibility: z
      .enum(['labelShow', 'labelShowIfUnread', 'labelHide'])
      .optional()
      .default('labelShow')
      .describe('Visibility in label list'),
    message_list_visibility: z
      .enum(['show', 'hide'])
      .optional()
      .default('show')
      .describe('Visibility in message list'),
    background_color: z
      .string()
      .optional()
      .describe('Background color in hex format (e.g., #000000)'),
    text_color: z
      .string()
      .optional()
      .describe('Text color in hex format (e.g., #ffffff)'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Modify message labels operation
  z.object({
    operation: z
      .literal('modify_message_labels')
      .describe('Add or remove labels from a message'),
    message_id: z
      .string()
      .min(1, 'Message ID is required')
      .describe('Gmail message ID to modify'),
    add_label_ids: z
      .array(z.string())
      .optional()
      .describe('List of label IDs to add (max 100)'),
    remove_label_ids: z
      .array(z.string())
      .optional()
      .describe('List of label IDs to remove (max 100)'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Modify thread labels operation
  z.object({
    operation: z
      .literal('modify_thread_labels')
      .describe('Add or remove labels from all messages in a thread'),
    thread_id: z
      .string()
      .min(1, 'Thread ID is required')
      .describe('Gmail thread ID to modify'),
    add_label_ids: z
      .array(z.string())
      .optional()
      .describe('List of label IDs to add to all messages in thread (max 100)'),
    remove_label_ids: z
      .array(z.string())
      .optional()
      .describe(
        'List of label IDs to remove from all messages in thread (max 100)'
      ),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),

  // Get attachment operation
  z.object({
    operation: z
      .literal('get_attachment')
      .describe('Download an attachment from an email message'),
    message_id: z
      .string()
      .min(1, 'Message ID is required')
      .describe('Gmail message ID that contains the attachment'),
    attachment_id: z
      .string()
      .min(1, 'Attachment ID is required')
      .describe(
        'Attachment ID from the message payload (found in body.attachmentId of attachment parts)'
      ),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),
]);

// Define result schemas for different operations
const GmailResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('send_email').describe('Send an email message'),
    success: z.boolean().describe('Whether the email was sent successfully'),
    message_id: z.string().optional().describe('Sent message ID'),
    thread_id: z.string().optional().describe('Thread ID'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('list_emails')
      .describe('List emails in the user mailbox'),
    success: z
      .boolean()
      .describe('Whether the email list was retrieved successfully'),
    messages: z
      .array(GmailMessageSchema)
      .optional()
      .describe('List of email messages'),
    next_page_token: z
      .string()
      .optional()
      .describe('Token for fetching next page'),
    result_size_estimate: z
      .number()
      .optional()
      .describe('Estimated total number of results'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('get_email').describe('Get a specific email message'),
    success: z
      .boolean()
      .describe('Whether the email was retrieved successfully'),
    message: GmailMessageSchema.optional().describe('Email message details'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('search_emails').describe('Search emails with query'),
    success: z
      .boolean()
      .describe('Whether the email search was completed successfully'),
    messages: z
      .array(GmailMessageSchema)
      .optional()
      .describe('List of matching email messages'),
    next_page_token: z
      .string()
      .optional()
      .describe(
        'Token for fetching the next page of results (pass as page_token)'
      ),
    result_size_estimate: z
      .number()
      .optional()
      .describe('Estimated total number of results'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('mark_as_read')
      .describe('Mark one or more messages as read'),
    success: z
      .boolean()
      .describe('Whether the messages were marked as read successfully'),
    modified_messages: z
      .array(z.string())
      .optional()
      .describe('IDs of messages that were modified'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('mark_as_unread')
      .describe('Mark one or more messages as unread'),
    success: z
      .boolean()
      .describe('Whether the messages were marked as unread successfully'),
    modified_messages: z
      .array(z.string())
      .optional()
      .describe('IDs of messages that were modified'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('create_draft').describe('Create a draft email'),
    success: z.boolean().describe('Whether the draft was created successfully'),
    draft: GmailDraftSchema.optional().describe('Created draft'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('send_draft').describe('Send a draft email'),
    success: z.boolean().describe('Whether the draft was sent successfully'),
    message_id: z.string().optional().describe('Sent message ID'),
    thread_id: z.string().optional().describe('Thread ID'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('list_drafts').describe('List draft emails'),
    success: z
      .boolean()
      .describe('Whether the draft list was retrieved successfully'),
    drafts: z.array(GmailDraftSchema).optional().describe('List of drafts'),
    next_page_token: z
      .string()
      .optional()
      .describe('Token for fetching next page'),
    result_size_estimate: z
      .number()
      .optional()
      .describe('Estimated total number of results'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('delete_email')
      .describe('Delete an email message permanently'),
    success: z.boolean().describe('Whether the email was deleted successfully'),
    deleted_message_id: z
      .string()
      .optional()
      .describe('ID of the deleted message'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('trash_email')
      .describe('Move an email message to trash'),
    success: z
      .boolean()
      .describe('Whether the email was moved to trash successfully'),
    trashed_message_id: z
      .string()
      .optional()
      .describe('ID of the trashed message'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('list_threads').describe('List email threads'),
    success: z
      .boolean()
      .describe('Whether the thread list was retrieved successfully'),
    threads: z
      .array(GmailThreadSchema)
      .optional()
      .describe('List of email threads'),
    next_page_token: z
      .string()
      .optional()
      .describe('Token for fetching next page'),
    result_size_estimate: z
      .number()
      .optional()
      .describe('Estimated total number of results'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('get_thread')
      .describe(
        'Get a full email thread with all of its messages (headers and decoded body text)'
      ),
    success: z
      .boolean()
      .describe('Whether the thread was retrieved successfully'),
    thread: GmailThreadSchema.optional().describe(
      'Thread with its messages (each carries essential headers and decoded textContent)'
    ),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('list_labels').describe('List all labels in mailbox'),
    success: z
      .boolean()
      .describe('Whether the label list was retrieved successfully'),
    labels: z
      .array(GmailLabelSchema)
      .optional()
      .describe('List of labels (both system and user labels)'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z.literal('create_label').describe('Create a new custom label'),
    success: z.boolean().describe('Whether the label was created successfully'),
    label: GmailLabelSchema.optional().describe('Created label details'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('modify_message_labels')
      .describe('Add or remove labels from a message'),
    success: z
      .boolean()
      .describe('Whether the labels were modified successfully'),
    message_id: z.string().optional().describe('Modified message ID'),
    label_ids: z
      .array(z.string())
      .optional()
      .describe('Current label IDs after modification'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('modify_thread_labels')
      .describe('Add or remove labels from all messages in a thread'),
    success: z
      .boolean()
      .describe('Whether the thread labels were modified successfully'),
    thread_id: z.string().optional().describe('Modified thread ID'),
    error: z.string().describe('Error message if operation failed'),
  }),

  z.object({
    operation: z
      .literal('get_attachment')
      .describe('Download an attachment from an email message'),
    success: z
      .boolean()
      .describe('Whether the attachment was downloaded successfully'),
    data: z.string().optional().describe('Base64-encoded attachment content'),
    size: z.number().optional().describe('Attachment size in bytes'),
    error: z.string().describe('Error message if operation failed'),
  }),
]);

type GmailResult = z.output<typeof GmailResultSchema>;
type GmailParams = z.input<typeof GmailParamsSchema>;

// Helper type to get the result type for a specific operation
export type GmailOperationResult<T extends GmailParams['operation']> = Extract<
  GmailResult,
  { operation: T }
>;

// Export the input type for external usage
export type GmailParamsInput = z.input<typeof GmailParamsSchema>;

export class GmailBubble<
  T extends GmailParams = GmailParams,
> extends ServiceBubble<
  T,
  Extract<GmailResult, { operation: T['operation'] }>
> {
  static readonly type = 'service' as const;
  static readonly service = 'gmail';
  static readonly authType = 'oauth' as const;
  static readonly bubbleName = 'gmail';
  // Doc-grounded per-operation side-effect classifications (IR-8);
  // generated by scripts/backfill-operation-metadata.ts
  static readonly operationMetadata = GMAIL_OPERATION_METADATA;
  static readonly schema = GmailParamsSchema;
  static readonly resultSchema = GmailResultSchema;
  static readonly shortDescription = 'Gmail integration for email management';
  static readonly longDescription = `
    Gmail service integration for comprehensive email management and automation.
    Use cases:
    - Send and receive emails with rich formatting and file attachments
    - Search and filter emails with advanced queries (paginated via page_token)
    - Read full threads (get_thread) and reply in-thread with RFC 2822 headers
    - Manage drafts and email threads
    - Mark messages as read/unread
    - Organize emails with labels and folders
    - Download attachments and read email metadata
  `;
  static readonly alias = 'gmail';

  constructor(
    params: T = {
      operation: 'list_emails',
      max_results: 10,
    } as T,
    context?: BubbleContext
  ) {
    super(params, context);
  }

  public async testCredential(): Promise<boolean> {
    const credential = this.chooseCredential();
    if (!credential) {
      throw new Error('Gmail credentials are required');
    }

    const response = await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/profile',
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail API error (${response.status}): ${text}`);
    }
    return true;
  }

  private async makeGmailApiRequest(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET',
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<any> {
    const url = endpoint.startsWith('https://')
      ? endpoint
      : `https://www.googleapis.com/gmail/v1/users/me${endpoint}`;

    const requestHeaders = {
      Authorization: `Bearer ${this.chooseCredential()}`,
      'Content-Type': 'application/json',
      ...headers,
    };

    const requestInit: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (body && method !== 'GET') {
      requestInit.body = JSON.stringify(body);
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gmail API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Handle empty responses
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  }

  /**
   * Extract clean, readable text content from a Gmail message
   */
  private extractEmailTextContent(message: any): string {
    if (!message.payload) return '';

    // Handle simple emails with direct body content
    if (message.payload.body && message.payload.body.data) {
      return this.decodeBase64(message.payload.body.data);
    }

    // Handle multipart emails - look for text/plain content
    if (message.payload.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body && part.body.data) {
          return this.decodeBase64(part.body.data);
        }

        // Handle nested multipart (e.g., multipart/alternative)
        if (part.mimeType?.startsWith('multipart/') && part.parts) {
          for (const subPart of part.parts) {
            if (
              subPart.mimeType === 'text/plain' &&
              subPart.body &&
              subPart.body.data
            ) {
              return this.decodeBase64(subPart.body.data);
            }
          }
        }
      }
    }

    return '';
  }

  /**
   * Decode base64url encoded content to UTF-8 string
   */
  private decodeBase64(base64String: string): string {
    try {
      // Convert base64url to base64
      const base64 = base64String.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(base64, 'base64').toString('utf-8');
    } catch (error) {
      console.warn('Failed to decode base64 content:', error);
      return '';
    }
  }

  /**
   * Clean up email content by removing forwarded/replied content and excessive whitespace
   */
  private cleanEmailContent(content: string): string {
    if (!content) return '';

    // Remove excessive whitespace and normalize line breaks
    const cleaned = content
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Optional: Remove forwarded message indicators (uncomment if needed)
    // cleaned = cleaned.replace(/^[\s\S]*?----- Forwarded message -----[\s\S]*$/gm, '');

    return cleaned;
  }

  /**
   * Clean up a body part by removing base64 data fields
   */
  private cleanBodyPart(part: any): any {
    if (!part) return part;

    const cleanedPart = { ...part };

    // Remove base64 data from body
    if (cleanedPart.body && cleanedPart.body.data) {
      cleanedPart.body = {
        ...cleanedPart.body,
        data: undefined,
      };
    }

    // Recursively clean nested parts
    if (cleanedPart.parts && Array.isArray(cleanedPart.parts)) {
      cleanedPart.parts = cleanedPart.parts.map((subPart: any) =>
        this.cleanBodyPart(subPart)
      );
    }

    return cleanedPart;
  }

  /**
   * Filter headers to only keep essential ones that users care about
   */
  private filterEssentialHeaders(
    headers: Array<{ name: string; value: string }>
  ): Array<{ name: string; value: string }> {
    if (!headers || !Array.isArray(headers)) return [];

    return headers.filter((header) =>
      ESSENTIAL_HEADERS.includes(
        header.name as (typeof ESSENTIAL_HEADERS)[number]
      )
    );
  }

  /**
   * Clean up payload by removing base64 data fields to reduce response size
   */
  private cleanPayloadData(payload: any): any {
    if (!payload) return payload;

    const cleanedPayload = { ...payload };

    // Filter headers to only essential ones
    if (cleanedPayload.headers && Array.isArray(cleanedPayload.headers)) {
      cleanedPayload.headers = this.filterEssentialHeaders(
        cleanedPayload.headers
      );
    }

    // Remove base64 data from main body
    if (cleanedPayload.body && cleanedPayload.body.data) {
      cleanedPayload.body = {
        ...cleanedPayload.body,
        data: undefined,
      };
    }

    // Clean up parts recursively
    if (cleanedPayload.parts && Array.isArray(cleanedPayload.parts)) {
      cleanedPayload.parts = cleanedPayload.parts.map((part: any) =>
        this.cleanBodyPart(part)
      );
    }

    return cleanedPayload;
  }

  /**
   * Process and clean a Gmail message by extracting text content and removing heavy fields
   */
  private async processAndCleanMessage(
    messageIdOrMessage: string | any
  ): Promise<any> {
    try {
      // If we only have an ID, fetch the full message
      const fullMessage =
        typeof messageIdOrMessage === 'string'
          ? await this.makeGmailApiRequest(
              `/messages/${messageIdOrMessage}?format=full`
            )
          : messageIdOrMessage;

      // Extract clean text content
      const rawTextContent = this.extractEmailTextContent(fullMessage);
      const cleanTextContent = this.cleanEmailContent(rawTextContent);

      // Clean up the payload by removing base64 data fields
      const cleanedPayload = this.cleanPayloadData(fullMessage.payload);

      // Return message with clean content and remove heavy fields
      return {
        ...fullMessage,
        textContent: cleanTextContent,
        payload: cleanedPayload,
        raw: undefined, // Remove the heavy raw field to reduce payload size
      };
    } catch (error) {
      // If processing fails, return the original message/ID
      console.warn(`Failed to process message:`, error);
      return typeof messageIdOrMessage === 'string'
        ? { id: messageIdOrMessage }
        : messageIdOrMessage;
    }
  }

  protected async performAction(
    context?: BubbleContext
  ): Promise<Extract<GmailResult, { operation: T['operation'] }>> {
    void context;

    const { operation } = this.params;

    try {
      const result = await (async (): Promise<GmailResult> => {
        switch (operation) {
          case 'send_email':
            return await this.sendEmail(this.params);
          case 'list_emails':
            return await this.listEmails(this.params);
          case 'get_email':
            return await this.getEmail(this.params);
          case 'search_emails':
            return await this.searchEmails(this.params);
          case 'mark_as_read':
            return await this.markAsRead(this.params);
          case 'mark_as_unread':
            return await this.markAsUnread(this.params);
          case 'create_draft':
            return await this.createDraft(this.params);
          case 'send_draft':
            return await this.sendDraft(this.params);
          case 'list_drafts':
            return await this.listDrafts(this.params);
          case 'delete_email':
            return await this.deleteEmail(this.params);
          case 'trash_email':
            return await this.trashEmail(this.params);
          case 'list_threads':
            return await this.listThreads(this.params);
          case 'get_thread':
            return await this.getThread(this.params);
          case 'list_labels':
            return await this.listLabels(this.params);
          case 'create_label':
            return await this.createLabel(this.params);
          case 'modify_message_labels':
            return await this.modifyMessageLabels(this.params);
          case 'modify_thread_labels':
            return await this.modifyThreadLabels(this.params);
          case 'get_attachment':
            return await this.getAttachment(this.params);
          default:
            throw new Error(`Unsupported operation: ${operation}`);
        }
      })();

      return result as Extract<GmailResult, { operation: T['operation'] }>;
    } catch (error) {
      return {
        operation,
        success: false,
        error:
          error instanceof Error ? error.message : 'Unknown error occurred',
      } as Extract<GmailResult, { operation: T['operation'] }>;
    }
  }

  private createEmailMessage(params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body_text?: string;
    body_html?: string;
    reply_to?: string;
    in_reply_to?: string;
    references?: string;
    attachments?: Array<{ filename: string; mime_type: string; data: string }>;
  }): string {
    const {
      to,
      cc,
      bcc,
      subject,
      body_text,
      body_html,
      reply_to,
      in_reply_to,
      references,
      attachments,
    } = params;

    let emailContent = '';
    emailContent += `To: ${to.join(', ')}\r\n`;

    if (cc && cc.length > 0) {
      emailContent += `Cc: ${cc.join(', ')}\r\n`;
    }

    if (bcc && bcc.length > 0) {
      emailContent += `Bcc: ${bcc.join(', ')}\r\n`;
    }

    emailContent += `Subject: ${encodeRFC2047(subject)}\r\n`;

    if (reply_to) {
      emailContent += `Reply-To: ${reply_to}\r\n`;
    }

    // RFC 2822 threading headers. In-Reply-To/References must carry the
    // Message-ID of the message being replied to — never the Gmail thread id,
    // which is an API identifier no mail client recognizes. Gmail requires
    // these headers (plus a matching Subject) for a message with threadId to
    // join the thread:
    // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
    if (in_reply_to) {
      const messageId = ensureAngleBrackets(in_reply_to);
      emailContent += `In-Reply-To: ${messageId}\r\n`;
      emailContent += `References: ${references?.trim() || messageId}\r\n`;
    } else if (references && references.trim()) {
      emailContent += `References: ${references.trim()}\r\n`;
    }

    emailContent += `MIME-Version: 1.0\r\n`;

    // Body section: single part or multipart/alternative for text+html.
    // Returned with its own Content-Type header line so it works both at the
    // top level and nested inside multipart/mixed.
    const buildBodySection = (): string => {
      let section = '';
      if (body_text && body_html) {
        const boundary = '----=_Part_alt_0123456789';
        section += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`;
        section += `\r\n`;
        section += `--${boundary}\r\n`;
        section += `Content-Type: text/plain; charset=UTF-8\r\n`;
        section += `\r\n`;
        section += `${body_text}\r\n`;
        section += `--${boundary}\r\n`;
        section += `Content-Type: text/html; charset=UTF-8\r\n`;
        section += `\r\n`;
        section += `${body_html}\r\n`;
        section += `--${boundary}--\r\n`;
      } else if (body_html) {
        section += `Content-Type: text/html; charset=UTF-8\r\n`;
        section += `\r\n`;
        section += `${body_html}\r\n`;
      } else if (body_text) {
        section += `Content-Type: text/plain; charset=UTF-8\r\n`;
        section += `\r\n`;
        section += `${body_text}\r\n`;
      }
      return section;
    };

    if (attachments && attachments.length > 0) {
      // multipart/mixed: body part first, then one base64 part per file
      // (https://developers.google.com/workspace/gmail/api/guides/sending)
      const mixedBoundary = '----=_Part_mixed_9876543210';
      emailContent += `Content-Type: multipart/mixed; boundary="${mixedBoundary}"\r\n`;
      emailContent += `\r\n`;
      emailContent += `--${mixedBoundary}\r\n`;
      emailContent += buildBodySection();
      for (const attachment of attachments) {
        const filename = encodeRFC2047(attachment.filename);
        emailContent += `--${mixedBoundary}\r\n`;
        emailContent += `Content-Type: ${attachment.mime_type}; name="${filename}"\r\n`;
        emailContent += `Content-Disposition: attachment; filename="${filename}"\r\n`;
        emailContent += `Content-Transfer-Encoding: base64\r\n`;
        emailContent += `\r\n`;
        emailContent += `${normalizeBase64ForMime(attachment.data)}\r\n`;
      }
      emailContent += `--${mixedBoundary}--\r\n`;
    } else {
      emailContent += buildBodySection();
    }

    // Convert to base64url encoding
    return Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Resolve RFC 2822 threading headers for a reply into an existing thread.
   * Fetches the thread's message headers (metadata format) and derives
   * In-Reply-To (last message's Message-ID) and References (that message's
   * References plus its Message-ID, per RFC 2822 section 3.6.4).
   * Returns {} when the lookup fails or yields no Message-ID — the send
   * still proceeds with threadId; it only loses cross-client threading.
   */
  private async resolveThreadingHeaders(
    threadId: string
  ): Promise<{ in_reply_to?: string; references?: string }> {
    try {
      const queryParams = new URLSearchParams({ format: 'metadata' });
      ['Message-ID', 'References'].forEach((header) =>
        queryParams.append('metadataHeaders', header)
      );

      const thread = await this.makeGmailApiRequest(
        `/threads/${threadId}?${queryParams.toString()}`
      );

      const messages: any[] = thread.messages || [];
      if (messages.length === 0) return {};

      const lastMessage = messages[messages.length - 1];
      const headers: Array<{ name: string; value: string }> =
        lastMessage.payload?.headers || [];
      const headerValue = (name: string): string | undefined =>
        headers.find(
          (header) => header.name.toLowerCase() === name.toLowerCase()
        )?.value;

      const lastMessageId = headerValue('Message-ID');
      if (!lastMessageId) return {};

      const messageId = ensureAngleBrackets(lastMessageId);
      const priorReferences = headerValue('References');

      return {
        in_reply_to: messageId,
        references: priorReferences
          ? `${priorReferences.trim()} ${messageId}`
          : messageId,
      };
    } catch {
      return {};
    }
  }

  private async sendEmail(
    params: Extract<GmailParams, { operation: 'send_email' }>
  ): Promise<Extract<GmailResult, { operation: 'send_email' }>> {
    const {
      to,
      cc,
      bcc,
      subject,
      body_text,
      body_html,
      reply_to,
      thread_id,
      in_reply_to,
      references,
      attachments,
    } = params;

    // Validate that at least one body type is provided
    if (!body_text && !body_html) {
      throw new Error('Either body_text or body_html must be provided');
    }

    // Auto-convert markdown text to HTML when no HTML is provided
    const resolvedHtml =
      body_html || (body_text ? markdownToHtml(body_text) : undefined);

    // Replying into a thread without explicit headers: derive In-Reply-To/
    // References from the thread so the reply threads across mail clients.
    let threading = { in_reply_to, references };
    if (thread_id && !in_reply_to) {
      const resolved = await this.resolveThreadingHeaders(thread_id);
      threading = {
        in_reply_to: resolved.in_reply_to,
        references: references ?? resolved.references,
      };
    }

    const raw = this.createEmailMessage({
      to,
      cc,
      bcc,
      subject,
      body_text,
      body_html: resolvedHtml,
      reply_to,
      in_reply_to: threading.in_reply_to,
      references: threading.references,
      attachments,
    });

    const messageData: any = { raw };
    if (thread_id) {
      messageData.threadId = thread_id;
    }

    const response = await this.makeGmailApiRequest(
      '/messages/send',
      'POST',
      messageData
    );

    return {
      operation: 'send_email',
      success: true,
      message_id: response.id,
      thread_id: response.threadId,
      error: '',
    };
  }

  private async listEmails(
    params: Extract<GmailParams, { operation: 'list_emails' }>
  ): Promise<Extract<GmailResult, { operation: 'list_emails' }>> {
    const {
      query,
      label_ids,
      include_spam_trash,
      max_results,
      page_token,
      include_details,
    } = params;

    const queryParams = new URLSearchParams({
      maxResults: max_results!.toString(),
    });

    if (query) queryParams.set('q', query);
    if (label_ids && label_ids.length > 0) {
      label_ids.forEach((labelId) => queryParams.append('labelIds', labelId));
    }
    if (include_spam_trash) queryParams.set('includeSpamTrash', 'true');
    if (page_token) queryParams.set('pageToken', page_token);

    const response = await this.makeGmailApiRequest(
      `/messages?${queryParams.toString()}`
    );

    let messages = response.messages || [];

    // If include_details is true, fetch full message details and extract clean content
    if (include_details && messages.length > 0) {
      messages = await Promise.all(
        messages.map((msg: any) => this.processAndCleanMessage(msg.id))
      );
    }

    return {
      operation: 'list_emails',
      success: true,
      messages,
      next_page_token: response.nextPageToken,
      result_size_estimate: response.resultSizeEstimate,
      error: '',
    };
  }

  private async getEmail(
    params: Extract<GmailParams, { operation: 'get_email' }>
  ): Promise<Extract<GmailResult, { operation: 'get_email' }>> {
    const { message_id, format, metadata_headers } = params;

    const queryParams = new URLSearchParams({
      format: format!,
    });

    if (metadata_headers && metadata_headers.length > 0) {
      metadata_headers.forEach((header) =>
        queryParams.append('metadataHeaders', header)
      );
    }

    const response = await this.makeGmailApiRequest(
      `/messages/${message_id}?${queryParams.toString()}`
    );

    // Clean up the message by removing heavy fields and adding clean text content
    const cleanedMessage =
      format === 'full' || format === 'raw'
        ? await this.processAndCleanMessage(response)
        : response;

    return {
      operation: 'get_email',
      success: true,
      message: cleanedMessage,
      error: '',
    };
  }

  private async searchEmails(
    params: Extract<GmailParams, { operation: 'search_emails' }>
  ): Promise<Extract<GmailResult, { operation: 'search_emails' }>> {
    const { query, max_results, page_token, include_spam_trash } = params;

    const queryParams = new URLSearchParams({
      q: query,
      maxResults: max_results!.toString(),
    });

    if (include_spam_trash) queryParams.set('includeSpamTrash', 'true');
    if (page_token) queryParams.set('pageToken', page_token);

    const response = await this.makeGmailApiRequest(
      `/messages?${queryParams.toString()}`
    );

    let messages = response.messages || [];

    // Since search_emails returns the same basic structure as list_emails,
    // we should apply the same cleaning logic for consistency
    if (messages.length > 0) {
      messages = await Promise.all(
        messages.map((msg: any) => this.processAndCleanMessage(msg.id))
      );
    }

    return {
      operation: 'search_emails',
      success: true,
      messages,
      next_page_token: response.nextPageToken,
      result_size_estimate: response.resultSizeEstimate,
      error: '',
    };
  }

  private async markAsRead(
    params: Extract<GmailParams, { operation: 'mark_as_read' }>
  ): Promise<Extract<GmailResult, { operation: 'mark_as_read' }>> {
    const { message_ids } = params;

    await this.makeGmailApiRequest('/messages/batchModify', 'POST', {
      ids: message_ids,
      removeLabelIds: ['UNREAD'],
    });

    return {
      operation: 'mark_as_read',
      success: true,
      modified_messages: message_ids,
      error: '',
    };
  }

  private async markAsUnread(
    params: Extract<GmailParams, { operation: 'mark_as_unread' }>
  ): Promise<Extract<GmailResult, { operation: 'mark_as_unread' }>> {
    const { message_ids } = params;

    await this.makeGmailApiRequest('/messages/batchModify', 'POST', {
      ids: message_ids,
      addLabelIds: ['UNREAD'],
    });

    return {
      operation: 'mark_as_unread',
      success: true,
      modified_messages: message_ids,
      error: '',
    };
  }

  private async createDraft(
    params: Extract<GmailParams, { operation: 'create_draft' }>
  ): Promise<Extract<GmailResult, { operation: 'create_draft' }>> {
    const {
      to,
      cc,
      bcc,
      subject,
      body_text,
      body_html,
      reply_to,
      thread_id,
      in_reply_to,
      references,
      attachments,
    } = params;

    // Validate that at least one body type is provided
    if (!body_text && !body_html) {
      throw new Error('Either body_text or body_html must be provided');
    }

    // Auto-convert markdown text to HTML when no HTML is provided
    const resolvedHtml =
      body_html || (body_text ? markdownToHtml(body_text) : undefined);

    // Replying into a thread without explicit headers: derive In-Reply-To/
    // References from the thread so the reply threads across mail clients.
    let threading = { in_reply_to, references };
    if (thread_id && !in_reply_to) {
      const resolved = await this.resolveThreadingHeaders(thread_id);
      threading = {
        in_reply_to: resolved.in_reply_to,
        references: references ?? resolved.references,
      };
    }

    const raw = this.createEmailMessage({
      to,
      cc,
      bcc,
      subject,
      body_text,
      body_html: resolvedHtml,
      reply_to,
      in_reply_to: threading.in_reply_to,
      references: threading.references,
      attachments,
    });

    const draftData: any = {
      message: { raw },
    };

    if (thread_id) {
      draftData.message.threadId = thread_id;
    }

    const response = await this.makeGmailApiRequest(
      '/drafts',
      'POST',
      draftData
    );

    return {
      operation: 'create_draft',
      success: true,
      draft: response,
      error: '',
    };
  }

  private async sendDraft(
    params: Extract<GmailParams, { operation: 'send_draft' }>
  ): Promise<Extract<GmailResult, { operation: 'send_draft' }>> {
    const { draft_id } = params;

    // Gmail API: POST /drafts/send with the draft id in the body.
    // There is no /drafts/{id}/send route — hitting it returns a generic
    // Google HTML 404 (not a Gmail API JSON error) because the request
    // never reaches a Gmail handler.
    const response = await this.makeGmailApiRequest('/drafts/send', 'POST', {
      id: draft_id,
    });

    return {
      operation: 'send_draft',
      success: true,
      message_id: response.id,
      thread_id: response.threadId,
      error: '',
    };
  }

  private async listDrafts(
    params: Extract<GmailParams, { operation: 'list_drafts' }>
  ): Promise<Extract<GmailResult, { operation: 'list_drafts' }>> {
    const { query, max_results, page_token, include_spam_trash } = params;

    const queryParams = new URLSearchParams({
      maxResults: max_results!.toString(),
    });

    if (query) queryParams.set('q', query);
    if (include_spam_trash) queryParams.set('includeSpamTrash', 'true');
    if (page_token) queryParams.set('pageToken', page_token);

    const response = await this.makeGmailApiRequest(
      `/drafts?${queryParams.toString()}`
    );

    let drafts = response.drafts || [];

    // Clean up draft messages to remove heavy fields
    if (drafts.length > 0) {
      drafts = await Promise.all(
        drafts.map(async (draft: any) => {
          if (draft.message) {
            const cleanedMessage = await this.processAndCleanMessage(
              draft.message
            );
            return {
              ...draft,
              message: cleanedMessage,
            };
          }
          return draft;
        })
      );
    }

    return {
      operation: 'list_drafts',
      success: true,
      drafts,
      next_page_token: response.nextPageToken,
      result_size_estimate: response.resultSizeEstimate,
      error: '',
    };
  }

  private async deleteEmail(
    params: Extract<GmailParams, { operation: 'delete_email' }>
  ): Promise<Extract<GmailResult, { operation: 'delete_email' }>> {
    const { message_id } = params;

    await this.makeGmailApiRequest(`/messages/${message_id}`, 'DELETE');

    return {
      operation: 'delete_email',
      success: true,
      deleted_message_id: message_id,
      error: '',
    };
  }

  private async trashEmail(
    params: Extract<GmailParams, { operation: 'trash_email' }>
  ): Promise<Extract<GmailResult, { operation: 'trash_email' }>> {
    const { message_id } = params;

    await this.makeGmailApiRequest(`/messages/${message_id}/trash`, 'POST');

    return {
      operation: 'trash_email',
      success: true,
      trashed_message_id: message_id,
      error: '',
    };
  }

  private async listThreads(
    params: Extract<GmailParams, { operation: 'list_threads' }>
  ): Promise<Extract<GmailResult, { operation: 'list_threads' }>> {
    const { query, label_ids, include_spam_trash, max_results, page_token } =
      params;

    const queryParams = new URLSearchParams({
      maxResults: max_results!.toString(),
    });

    if (query) queryParams.set('q', query);
    if (label_ids && label_ids.length > 0) {
      label_ids.forEach((labelId) => queryParams.append('labelIds', labelId));
    }
    if (include_spam_trash) queryParams.set('includeSpamTrash', 'true');
    if (page_token) queryParams.set('pageToken', page_token);

    const response = await this.makeGmailApiRequest(
      `/threads?${queryParams.toString()}`
    );

    return {
      operation: 'list_threads',
      success: true,
      threads: response.threads || [],
      next_page_token: response.nextPageToken,
      result_size_estimate: response.resultSizeEstimate,
      error: '',
    };
  }

  private async getThread(
    params: Extract<GmailParams, { operation: 'get_thread' }>
  ): Promise<Extract<GmailResult, { operation: 'get_thread' }>> {
    const { thread_id, format, metadata_headers } = params;

    // users.threads.get — format=full returns each message with body content
    // parsed into payload (threads.list returns message-less stubs):
    // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get
    const queryParams = new URLSearchParams({
      format: format!,
    });

    if (metadata_headers && metadata_headers.length > 0) {
      metadata_headers.forEach((header) =>
        queryParams.append('metadataHeaders', header)
      );
    }

    const response = await this.makeGmailApiRequest(
      `/threads/${thread_id}?${queryParams.toString()}`
    );

    let messages = response.messages || [];

    // For full format, decode body text and strip heavy base64 fields the
    // same way get_email does (messages are already full objects — no
    // per-message re-fetch)
    if (format === 'full' && messages.length > 0) {
      messages = await Promise.all(
        messages.map((message: any) => this.processAndCleanMessage(message))
      );
    }

    return {
      operation: 'get_thread',
      success: true,
      thread: {
        ...response,
        messages,
      },
      error: '',
    };
  }

  private async listLabels(
    params: Extract<GmailParams, { operation: 'list_labels' }>
  ): Promise<Extract<GmailResult, { operation: 'list_labels' }>> {
    void params;

    const response = await this.makeGmailApiRequest('/labels');

    return {
      operation: 'list_labels',
      success: true,
      labels: response.labels || [],
      error: '',
    };
  }

  private async createLabel(
    params: Extract<GmailParams, { operation: 'create_label' }>
  ): Promise<Extract<GmailResult, { operation: 'create_label' }>> {
    const {
      name,
      label_list_visibility,
      message_list_visibility,
      background_color,
      text_color,
    } = params;

    const requestBody: {
      name: string;
      labelListVisibility?: string;
      messageListVisibility?: string;
      color?: {
        backgroundColor?: string;
        textColor?: string;
      };
    } = {
      name,
    };

    if (label_list_visibility) {
      requestBody.labelListVisibility = label_list_visibility;
    }

    if (message_list_visibility) {
      requestBody.messageListVisibility = message_list_visibility;
    }

    if (background_color || text_color) {
      requestBody.color = {};
      if (background_color) {
        requestBody.color.backgroundColor = background_color;
      }
      if (text_color) {
        requestBody.color.textColor = text_color;
      }
    }

    const response = await this.makeGmailApiRequest(
      '/labels',
      'POST',
      requestBody
    );

    return {
      operation: 'create_label',
      success: true,
      label: response,
      error: '',
    };
  }

  private async modifyMessageLabels(
    params: Extract<GmailParams, { operation: 'modify_message_labels' }>
  ): Promise<Extract<GmailResult, { operation: 'modify_message_labels' }>> {
    const { message_id, add_label_ids, remove_label_ids } = params;

    // Validate that at least one operation is specified
    if (
      (!add_label_ids || add_label_ids.length === 0) &&
      (!remove_label_ids || remove_label_ids.length === 0)
    ) {
      throw new Error(
        'At least one of add_label_ids or remove_label_ids must be provided'
      );
    }

    const requestBody: {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    } = {};

    if (add_label_ids && add_label_ids.length > 0) {
      requestBody.addLabelIds = add_label_ids;
    }

    if (remove_label_ids && remove_label_ids.length > 0) {
      requestBody.removeLabelIds = remove_label_ids;
    }

    const response = await this.makeGmailApiRequest(
      `/messages/${message_id}/modify`,
      'POST',
      requestBody
    );

    return {
      operation: 'modify_message_labels',
      success: true,
      message_id: response.id,
      label_ids: response.labelIds || [],
      error: '',
    };
  }

  private async modifyThreadLabels(
    params: Extract<GmailParams, { operation: 'modify_thread_labels' }>
  ): Promise<Extract<GmailResult, { operation: 'modify_thread_labels' }>> {
    const { thread_id, add_label_ids, remove_label_ids } = params;

    // Validate that at least one operation is specified
    if (
      (!add_label_ids || add_label_ids.length === 0) &&
      (!remove_label_ids || remove_label_ids.length === 0)
    ) {
      throw new Error(
        'At least one of add_label_ids or remove_label_ids must be provided'
      );
    }

    const requestBody: {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    } = {};

    if (add_label_ids && add_label_ids.length > 0) {
      requestBody.addLabelIds = add_label_ids;
    }

    if (remove_label_ids && remove_label_ids.length > 0) {
      requestBody.removeLabelIds = remove_label_ids;
    }

    const response = await this.makeGmailApiRequest(
      `/threads/${thread_id}/modify`,
      'POST',
      requestBody
    );

    return {
      operation: 'modify_thread_labels',
      success: true,
      thread_id: response.id,
      error: '',
    };
  }

  private async getAttachment(
    params: Extract<GmailParams, { operation: 'get_attachment' }>
  ): Promise<Extract<GmailResult, { operation: 'get_attachment' }>> {
    const { message_id, attachment_id } = params;

    const response = await this.makeGmailApiRequest(
      `/messages/${message_id}/attachments/${attachment_id}`
    );

    // Gmail API returns base64url-encoded data — convert to standard base64 with proper padding
    let base64Data: string | undefined;
    if (response.data) {
      let converted = (response.data as string)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      // Add padding if missing — required for standard base64 and downstream consumers
      const paddingNeeded = (4 - (converted.length % 4)) % 4;
      converted += '='.repeat(paddingNeeded);
      base64Data = converted;
    }

    return {
      operation: 'get_attachment',
      success: true,
      data: base64Data,
      size: response.size as number | undefined,
      error: '',
    };
  }

  protected chooseCredential(): string | undefined {
    const { credentials } = this.params as {
      credentials?: Record<string, string>;
    };

    if (!credentials || typeof credentials !== 'object') {
      throw new Error('No Gmail credentials provided');
    }

    // Gmail bubble uses GMAIL_CRED credentials
    return credentials[CredentialType.GMAIL_CRED];
  }
}
