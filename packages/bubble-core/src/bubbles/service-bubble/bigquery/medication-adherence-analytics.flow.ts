import { BubbleFlow } from '../../../bubble-flow/bubble-flow-class.js';
import { BigQueryBubble } from './bigquery.js';
import type { CronEvent } from '@bubblelab/shared-schemas';

/**
 * Medication-adherence analytics flow (example for the generated bigquery
 * bubble).
 *
 * Weekly schedule -> ingest raw adherence events (PII-bearing EHR/pharmacy
 * export) -> de-identify (strip name/email/phone/address, salted-hash the
 * patient identifier, truncate event timestamps to the ISO week) -> stream
 * the de-identified aggregate rows into the warehouse (tabledata_insert_all)
 * -> run the cohort adherence-vs-outcome summary query (jobs_query).
 *
 * Only de-identified records ever leave this flow; the raw events exist
 * in-memory for the duration of one run.
 */

/** Raw adherence event as exported by the EHR/pharmacy system (contains PII). */
interface RawAdherenceEvent {
  patientId: string;
  patientName: string;
  patientEmail: string;
  patientPhone: string;
  patientAddress: string;
  medicationCode: string;
  eventType: 'dose_taken' | 'dose_missed' | 'refill';
  occurredAt: string; // ISO 8601 timestamp
  outcomeScore: number; // 0-100 clinician-reported outcome measure
}

/** De-identified record: no direct identifiers, week-granular time. */
interface DeidentifiedAdherenceRecord {
  patientKey: string; // salted hash of patientId — not reversible from the row
  medicationCode: string;
  eventType: RawAdherenceEvent['eventType'];
  eventWeek: string; // ISO date of the Monday of the event's week
  outcomeScore: number;
  [key: string]: unknown; // matches the insert row's open JSON object shape
}

export interface MedicationAdherencePayload extends CronEvent {
  /** GCP project holding the analytics dataset. */
  projectId?: string;
  /** Dataset/table receiving de-identified adherence rows. */
  datasetId?: string;
  tableId?: string;
  /** Salt for the patient-identifier hash; rotate to re-key the cohort. */
  pseudonymSalt?: string;
}

export interface Output {
  ingestedEvents: number;
  insertedRows: number;
  insertErrors: number;
  cohortSummary: {
    jobComplete: boolean;
    totalRows: string;
    rows: Array<Record<string, unknown>>;
  } | null;
  error?: string;
}

const DEFAULTS = {
  projectId: 'clinical-analytics-project',
  datasetId: 'medication_adherence',
  tableId: 'weekly_adherence_events',
  endpointUrl: 'https://bigquery.googleapis.com/bigquery/v2',
} as const;

/**
 * FNV-1a 32-bit, applied twice (forward + reversed input) for a 16-hex-char
 * pseudonym. Deterministic and dependency-free; NOT for cryptographic use —
 * swap for an HSM/KMS-backed keyed hash before production.
 */
function pseudonymize(value: string, salt: string): string {
  const fnv1a = (input: string): number => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  };
  const salted = `${salt}:${value}`;
  const reversed = [...salted].reverse().join('');
  return (
    fnv1a(salted).toString(16).padStart(8, '0') +
    fnv1a(reversed).toString(16).padStart(8, '0')
  );
}

/** Truncate an ISO timestamp to the Monday of its (UTC) week. */
function toIsoWeekStart(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const day = date.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export class MedicationAdherenceAnalyticsFlow extends BubbleFlow<'schedule/cron'> {
  // Mondays at 06:00 — after the weekend batch of pharmacy exports lands.
  readonly cronSchedule = '0 6 * * 1';

  constructor() {
    super(
      'medication-adherence-analytics',
      'Weekly de-identified medication-adherence ingest into the warehouse plus a cohort adherence-vs-outcome summary'
    );
  }

  /**
   * Ingestion point. In production this reads the EHR/pharmacy adherence
   * export (SFTP drop, FHIR MedicationStatement feed, ...); the sample batch
   * demonstrates the shape the de-identification step expects.
   */
  private fetchAdherenceEvents(): RawAdherenceEvent[] {
    return [
      {
        patientId: 'MRN-004211',
        patientName: 'Jane Placeholder',
        patientEmail: 'jane@example.com',
        patientPhone: '+1-555-0100',
        patientAddress: '1 Example Way, Springfield',
        medicationCode: 'RXN-860975', // metformin 500mg (RxNorm)
        eventType: 'dose_taken',
        occurredAt: '2026-07-14T08:12:00Z',
        outcomeScore: 82,
      },
      {
        patientId: 'MRN-004211',
        patientName: 'Jane Placeholder',
        patientEmail: 'jane@example.com',
        patientPhone: '+1-555-0100',
        patientAddress: '1 Example Way, Springfield',
        medicationCode: 'RXN-860975',
        eventType: 'dose_missed',
        occurredAt: '2026-07-15T08:00:00Z',
        outcomeScore: 82,
      },
      {
        patientId: 'MRN-009840',
        patientName: 'John Placeholder',
        patientEmail: 'john@example.com',
        patientPhone: '+1-555-0101',
        patientAddress: '2 Example Way, Springfield',
        medicationCode: 'RXN-197361', // lisinopril 10mg (RxNorm)
        eventType: 'refill',
        occurredAt: '2026-07-16T15:40:00Z',
        outcomeScore: 74,
      },
    ];
  }

  /**
   * De-identification transform: drops every direct identifier (name, email,
   * phone, address), replaces the patient identifier with a salted hash, and
   * truncates the event time to the ISO week. Only fields listed in
   * DeidentifiedAdherenceRecord survive.
   */
  private deidentify(
    events: RawAdherenceEvent[],
    salt: string
  ): DeidentifiedAdherenceRecord[] {
    return events.map((event) => ({
      patientKey: pseudonymize(event.patientId, salt),
      medicationCode: event.medicationCode,
      eventType: event.eventType,
      eventWeek: toIsoWeekStart(event.occurredAt),
      outcomeScore: event.outcomeScore,
    }));
  }

  async handle(payload: MedicationAdherencePayload): Promise<Output> {
    const projectId = payload.projectId ?? DEFAULTS.projectId;
    const datasetId = payload.datasetId ?? DEFAULTS.datasetId;
    const tableId = payload.tableId ?? DEFAULTS.tableId;
    const salt = payload.pseudonymSalt ?? 'rotate-me-quarterly';

    // 1. Ingest the raw (PII-bearing) adherence events.
    const rawEvents = this.fetchAdherenceEvents();

    // 2. De-identify before anything touches the warehouse.
    const records = this.deidentify(rawEvents, salt);

    // 3. Stream the de-identified rows into the warehouse.
    //    insertId = patientKey + week + type: BigQuery best-effort dedup on
    //    re-runs of the same batch.
    const insertResult = await new BigQueryBubble(
      {
        operation: 'tabledata_insert_all',
        endpointUrl: DEFAULTS.endpointUrl,
        projectId,
        datasetId,
        tableId,
        skipInvalidRows: false,
        ignoreUnknownValues: false,
        rows: records.map((record) => ({
          insertId: `${record.patientKey}:${record.eventWeek}:${record.eventType}:${record.medicationCode}`,
          json: record,
        })),
      },
      undefined,
      'insert-adherence-rows'
    ).action();

    if (!insertResult.success) {
      return {
        ingestedEvents: rawEvents.length,
        insertedRows: 0,
        insertErrors: 0,
        cohortSummary: null,
        error: `warehouse insert failed: ${insertResult.error}`,
      };
    }
    const insertErrors = insertResult.data?.insertErrors?.length ?? 0;

    // 4. Cohort summary: adherence rate vs mean outcome per medication/week.
    const summaryResult = await new BigQueryBubble(
      {
        operation: 'jobs_query',
        endpointUrl: DEFAULTS.endpointUrl,
        projectId,
        useLegacySql: false,
        query: `
        SELECT
          medicationCode,
          eventWeek,
          COUNTIF(eventType = 'dose_taken') / NULLIF(COUNTIF(eventType IN ('dose_taken', 'dose_missed')), 0) AS adherence_rate,
          AVG(outcomeScore) AS mean_outcome_score,
          COUNT(DISTINCT patientKey) AS cohort_size
        FROM \`${projectId}.${datasetId}.${tableId}\`
        GROUP BY medicationCode, eventWeek
        ORDER BY eventWeek DESC, medicationCode
      `,
      },
      undefined,
      'cohort-adherence-summary'
    ).action();

    if (!summaryResult.success) {
      return {
        ingestedEvents: rawEvents.length,
        insertedRows: records.length - insertErrors,
        insertErrors,
        cohortSummary: null,
        error: `cohort summary query failed: ${summaryResult.error}`,
      };
    }

    // BigQuery JSON_ARRAY-style rows: f = fields, v = value, column order
    // matches the schema field order.
    const summary = summaryResult.data;
    const columns =
      summary?.schema?.fields?.map((field) => field.name ?? '') ?? [];
    const rows = (summary?.rows ?? []).map((row) => {
      const out: Record<string, unknown> = {};
      row.f?.forEach((cell, index) => {
        out[columns[index] ?? `column_${index}`] = cell.v;
      });
      return out;
    });

    return {
      ingestedEvents: rawEvents.length,
      insertedRows: records.length - insertErrors,
      insertErrors,
      cohortSummary: {
        jobComplete: summary?.jobComplete ?? false,
        totalRows: summary?.totalRows ?? '0',
        rows,
      },
    };
  }
}
