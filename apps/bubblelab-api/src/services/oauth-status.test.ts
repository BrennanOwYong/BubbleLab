/**
 * S6 — computeOauthStatus, the single source of truth for OAuth access-token
 * health shared by GET /credentials and GET /bubble-flow/:id/credential-state
 * (the fixer's grounding endpoint). The thresholds are the ones the
 * credentials route always used inline: expired < now, needs_refresh within
 * 5 minutes, active beyond.
 */
import { describe, expect, it } from 'bun:test';
import { computeOauthStatus } from './oauth-status.js';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('computeOauthStatus', () => {
  it('returns undefined for non-OAuth credentials', () => {
    expect(computeOauthStatus(false, minutes(60), NOW)).toBeUndefined();
    expect(computeOauthStatus(null, minutes(60), NOW)).toBeUndefined();
    expect(computeOauthStatus(undefined, minutes(60), NOW)).toBeUndefined();
  });

  it('returns undefined when no expiry is stored', () => {
    expect(computeOauthStatus(true, null, NOW)).toBeUndefined();
    expect(computeOauthStatus(true, undefined, NOW)).toBeUndefined();
  });

  it('classifies a lapsed access token as expired', () => {
    expect(computeOauthStatus(true, minutes(-1), NOW)).toBe('expired');
    expect(computeOauthStatus(true, minutes(-60 * 24), NOW)).toBe('expired');
  });

  it('classifies expiry within the 5-minute window as needs_refresh', () => {
    expect(computeOauthStatus(true, minutes(1), NOW)).toBe('needs_refresh');
    expect(computeOauthStatus(true, minutes(4.9), NOW)).toBe('needs_refresh');
  });

  it('classifies expiry beyond the window as active', () => {
    expect(computeOauthStatus(true, minutes(6), NOW)).toBe('active');
    expect(computeOauthStatus(true, minutes(60 * 24), NOW)).toBe('active');
  });
});
