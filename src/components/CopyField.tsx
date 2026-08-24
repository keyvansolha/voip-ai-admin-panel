'use client';

import { useState } from 'react';

/**
 * Shows a value that the operator needs to copy elsewhere (the webhook URL, the
 * ingest token). Secrets start masked so the page can be screen-shared without
 * leaking them.
 */
export function CopyField({
  value,
  label,
  secret = false,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  label: string;
  secret?: boolean;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [revealed, setRevealed] = useState(!secret);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access needs a secure context; the value is selectable anyway.
      setRevealed(true);
    }
  }

  return (
    <div>
      <span className="field-label">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code
          dir="ltr"
          className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border-strong bg-surface-sunken px-3 py-2 font-mono text-xs whitespace-nowrap"
        >
          {revealed ? value : '•'.repeat(Math.min(value.length, 44))}
        </code>

        {secret ? (
          <button type="button" onClick={() => setRevealed((on) => !on)} className="btn btn-sm">
            {revealed ? 'Hide' : 'Show'}
          </button>
        ) : null}

        <button type="button" onClick={copy} className="btn btn-sm">
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
    </div>
  );
}
