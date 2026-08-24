import type { ReactNode } from 'react';

/**
 * Form controls for the Settings page.
 *
 * Every input is named after its settings key, which is what lets
 * `saveSettingsAction` read the form generically instead of listing fields
 * twice. Booleans additionally register in the section's `__booleans` list so
 * an unchecked box is distinguishable from a field that was never rendered.
 */

export function Section({
  id,
  title,
  children,
  action,
  booleans = [],
  footer,
}: {
  id: string;
  title: string;
  children: ReactNode;
  action: (formData: FormData) => void | Promise<void>;
  booleans?: string[];
  footer?: ReactNode;
}) {
  return (
    <section id={id} className="card scroll-mt-6">
      <header className="card-header">
        <h2 className="card-title">{title}</h2>
      </header>

      <form action={action} className="space-y-4 p-4">
        <input type="hidden" name="__section" value={id} />
        <input type="hidden" name="__booleans" value={booleans.join(',')} />
        {children}
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {footer}
        </div>
      </form>
    </section>
  );
}

export function TextField({
  name,
  label,
  defaultValue,
  hint,
  type = 'text',
  dir = 'ltr',
  placeholder,
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string | number;
  hint?: ReactNode;
  type?: 'text' | 'number' | 'url' | 'password';
  dir?: 'ltr' | 'rtl' | 'auto';
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        dir={dir}
        step={type === 'number' ? 'any' : undefined}
        className="input"
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextAreaField({
  name,
  label,
  defaultValue,
  hint,
  rows = 6,
  placeholder,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  hint?: ReactNode;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <textarea
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        placeholder={placeholder}
        dir="ltr"
        className="textarea"
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function SelectField({
  name,
  label,
  defaultValue,
  options,
  hint,
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
  hint?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <select name={name} defaultValue={defaultValue} className="input">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function CheckboxField({
  name,
  label,
  defaultChecked,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
  hint?: ReactNode;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent-strong)]"
        />
        <span className="text-sm">{label}</span>
      </label>
      {hint ? <span className="field-hint ms-6.5 block">{hint}</span> : null}
    </div>
  );
}

/**
 * A secret that is stored but never sent back to the browser: the field shows
 * whether one is configured, an empty box keeps it, and the Clear checkbox is
 * the only way to remove it.
 */
export function SecretField({
  name,
  label,
  isSet,
  hint,
  labels,
  multiline = false,
}: {
  name: string;
  label: string;
  isSet: boolean;
  hint?: ReactNode;
  labels: { set: string; unset: string; keep: string; clear: string };
  multiline?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="field-label mb-0">{label}</span>
        <span
          className={`badge ${isSet ? 'border-ok/40 bg-ok/10 text-ok' : 'border-warn/40 bg-warn/10 text-warn'}`}
        >
          {isSet ? labels.set : labels.unset}
        </span>
      </div>

      {multiline ? (
        <textarea name={name} rows={6} placeholder={labels.keep} dir="ltr" className="textarea" />
      ) : (
        <input
          name={name}
          type="password"
          autoComplete="new-password"
          placeholder={labels.keep}
          dir="ltr"
          className="input"
        />
      )}

      {hint ? <span className="field-hint">{hint}</span> : null}

      {isSet ? (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-content-faint">
          <input
            type="checkbox"
            name={`clear:${name}`}
            className="size-3.5 accent-[var(--color-danger)]"
          />
          {labels.clear}
        </label>
      ) : null}
    </div>
  );
}
