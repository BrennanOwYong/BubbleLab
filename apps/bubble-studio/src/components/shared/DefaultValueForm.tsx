/**
 * Default-value form over FieldDescriptor[] — the form re-created inside the
 * Conversation tab when a `workflow-done-needs-info` message arrives, and the
 * canonical implementation of the C1 rule:
 * - `header` is the label,
 * - a KNOWN value renders as the input's real `value` (normal text color),
 * - `hint` is the placeholder ONLY while the field has no value.
 * Edits flow into the caller's value store (execution inputs), so what the
 * user types here is what the flow runs with.
 */
import type { FieldDescriptor } from '../../utils/fieldDescriptor';
import {
  matchProfileDefault,
  resolveFieldText,
} from '../../utils/fieldDescriptor';

export function DefaultValueForm({
  fields,
  values,
  onValueChange,
  profileDefaults,
  disabled = false,
}: {
  fields: FieldDescriptor[];
  /** Live values keyed by field key (edits land here via onValueChange) */
  values: Record<string, unknown>;
  onValueChange: (key: string, value: string) => void;
  /** Optional profile default map from GET /bubble-flow/:id */
  profileDefaults?: Record<string, string>;
  disabled?: boolean;
}) {
  if (fields.length === 0) return null;

  return (
    <div className="mt-2 space-y-2.5">
      {fields.map((field) => {
        const { displayValue, placeholder } = resolveFieldText({
          storedValue: values[field.key],
          knownValue:
            field.value ?? matchProfileDefault(field.key, profileDefaults),
          hint: field.hint,
          name: field.key,
        });
        return (
          <div key={field.key}>
            <label
              className="block text-xs font-semibold text-neutral-200 mb-1"
              htmlFor={`needs-info-${field.key}`}
            >
              {field.header}
            </label>
            <input
              id={`needs-info-${field.key}`}
              type="text"
              value={displayValue}
              placeholder={placeholder}
              disabled={disabled}
              onChange={(event) => onValueChange(field.key, event.target.value)}
              className="w-full px-2 py-1.5 text-xs bg-neutral-900 border border-neutral-600 focus:border-blue-500 rounded text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            />
            {displayValue === '' && field.hint && (
              <p className="mt-0.5 text-[10px] text-neutral-500">
                {field.hint}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
