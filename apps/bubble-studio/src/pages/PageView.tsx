/**
 * Renders a stored page (page-builder MVP): the server resolves every read
 * widget's live data (GET /page/:pageId/render); form widgets submit through
 * POST /page/:pageId/submit and the page re-renders so the write is visible.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  fetchRenderedPage,
  submitPageForm,
  type RenderedPage,
  type RenderedWidget,
} from '../services/pageApi';

function TableWidget({ rendered }: { rendered: RenderedWidget }) {
  if (rendered.data.kind !== 'table') return null;
  const { header, rows } = rendered.data;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-left">
        {header !== null && (
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="px-3 py-2 text-xs uppercase tracking-wide text-gray-400 border-b border-gray-700"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-gray-800/60">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-2 text-gray-200">
                  {String(cell)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="px-3 py-3 text-gray-500 text-sm">No rows yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function FormWidget({
  pageId,
  rendered,
  onSubmitted,
}: {
  pageId: number;
  rendered: RenderedWidget;
  onSubmitted: () => void;
}) {
  const widget = rendered.widget;
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (widget.type !== 'form') return null;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const result = await submitPageForm(pageId, widget.id, values);
      setNotice(`Added (${result.updatedRange})`);
      setValues({});
      onSubmitted();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      {widget.fields.map((field) => (
        <label key={field.name} className="block">
          <span className="text-xs text-gray-400">{field.label}</span>
          <input
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
            placeholder={field.placeholder ?? ''}
            value={values[field.name] ?? ''}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
            }
          />
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button
          className="px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 rounded-lg text-sm text-white"
          disabled={submitting}
          onClick={() => void submit()}
        >
          {submitting ? 'Submitting…' : widget.submitLabel}
        </button>
        {notice !== null && (
          <span className="text-xs text-gray-400">{notice}</span>
        )}
      </div>
    </div>
  );
}

function WidgetCard({
  pageId,
  rendered,
  onSubmitted,
}: {
  pageId: number;
  rendered: RenderedWidget;
  onSubmitted: () => void;
}) {
  const { widget, data } = rendered;
  return (
    <div className="bg-gray-800/60 border border-gray-700/60 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">
        {widget.title}
      </h2>
      {data.kind === 'error' && (
        <p className="text-sm text-red-400">{data.message}</p>
      )}
      {data.kind === 'metric' && (
        <p className="text-4xl font-bold text-gray-100">{data.value}</p>
      )}
      {data.kind === 'table' && <TableWidget rendered={rendered} />}
      {data.kind === 'form' && (
        <FormWidget
          pageId={pageId}
          rendered={rendered}
          onSubmitted={onSubmitted}
        />
      )}
    </div>
  );
}

export function PageView({ pageId }: { pageId: number }) {
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchRenderedPage(pageId)
      .then((rendered) => {
        setPage(rendered);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  }, [pageId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="max-w-4xl mx-auto w-full px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">
          {page?.title ?? `Page #${pageId}`}
        </h1>
        <div className="flex items-center gap-3">
          <Link
            to="/build-page/$pageId"
            params={{ pageId: String(pageId) }}
            className="text-xs text-purple-400 hover:text-purple-300 underline"
          >
            Edit with agent
          </Link>
          <button
            className="text-xs text-gray-400 hover:text-gray-200 underline"
            onClick={refresh}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      {page?.spec.description !== undefined && (
        <p className="text-sm text-gray-400">{page.spec.description}</p>
      )}
      {page?.widgets.map((rendered) => (
        <WidgetCard
          key={rendered.widget.id}
          pageId={pageId}
          rendered={rendered}
          onSubmitted={refresh}
        />
      ))}
      {page === null && !loading && error === null && (
        <p className="text-sm text-gray-500">Nothing to show.</p>
      )}
    </div>
  );
}
