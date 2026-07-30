/**
 * Client for the /page API (page-builder MVP): page CRUD, server-side render
 * (read widgets resolved with live integration data), and form submits.
 */
import { api } from '../lib/api';

export interface PageSummary {
  id: number;
  title: string;
  status: string;
}

// Mirrors services/builder-agent/src/page-spec.ts (the spec's owning module).
export interface SheetRangeSource {
  kind: 'google_sheet_range';
  spreadsheetId: string;
  range: string;
}

export interface SheetAppendTarget {
  kind: 'google_sheet_append';
  spreadsheetId: string;
  range: string;
}

export interface FormField {
  name: string;
  label: string;
  placeholder?: string;
}

export type PageWidget =
  | {
      id: string;
      type: 'table';
      title: string;
      source: SheetRangeSource;
      headerRow: boolean;
      maxRows: number;
    }
  | {
      id: string;
      type: 'metric';
      title: string;
      source: SheetRangeSource;
      aggregate: 'count_rows';
      excludeHeaderRow: boolean;
    }
  | {
      id: string;
      type: 'form';
      title: string;
      target: SheetAppendTarget;
      fields: FormField[];
      submitLabel: string;
    };

export type SheetCell = string | number | boolean;

export type WidgetData =
  | { kind: 'table'; header: string[] | null; rows: SheetCell[][] }
  | { kind: 'metric'; value: number }
  | { kind: 'form' }
  | { kind: 'error'; message: string };

export interface RenderedWidget {
  widget: PageWidget;
  data: WidgetData;
}

export interface RenderedPage {
  pageId: number;
  title: string;
  status: string;
  spec: { version: 1; title: string; description?: string };
  widgets: RenderedWidget[];
}

export function createPage(title?: string): Promise<PageSummary> {
  return api.post<PageSummary>('/page', { title: title ?? 'Untitled page' });
}

export function fetchRenderedPage(pageId: number): Promise<RenderedPage> {
  return api.get<RenderedPage>(`/page/${pageId}/render`);
}

export function submitPageForm(
  pageId: number,
  widgetId: string,
  values: Record<string, string>
): Promise<{ status: string; updatedRange: string; updatedRows: number }> {
  return api.post(`/page/${pageId}/submit`, { widgetId, values });
}
