'use client';

import { useState, useTransition } from 'react';

/**
 * Runs a saved-credentials check against /api/admin/test and shows the result
 * inline. Deliberately tests what is stored, not what is typed, so the button
 * confirms the configuration the worker will actually use.
 */
export function TestConnectionButton({
  target,
  label,
  busyLabel,
}: {
  target: 'ai' | 'panel';
  label: string;
  busyLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/admin/test?target=${target}`, { method: 'POST' });
        const body = (await response.json()) as { ok: boolean; message?: string; error?: string };
        setResult({ ok: body.ok, text: body.ok ? (body.message ?? 'OK') : (body.error ?? 'Failed') });
      } catch (cause) {
        setResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
      }
    });
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={run} disabled={pending} className="btn btn-sm">
        {pending ? busyLabel : label}
      </button>

      {result ? (
        <p
          dir="auto"
          className={`rounded-md border px-3 py-2 text-xs break-words ${
            result.ok
              ? 'border-ok/40 bg-ok/10 text-ok'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
