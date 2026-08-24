/**
 * Next.js calls `register()` once per server process, before the first request.
 * That is where the one-time boot work goes: run migrations (done as a side
 * effect of opening the database), seed prompts, make sure an ingest token
 * exists, and start the background worker.
 *
 * The edge runtime has no filesystem or native modules, so everything is
 * guarded on NEXT_RUNTIME.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { seedPrompts } = await import('./lib/ai/prompts');
  const { ensureIngestToken } = await import('./lib/settings');
  const { ensureBootstrapAdmin } = await import('./lib/auth/users');
  const { startWorker } = await import('./lib/worker');
  const { logEvent } = await import('./lib/logger');

  try {
    seedPrompts();
    ensureIngestToken();

    const admin = ensureBootstrapAdmin();
    if (admin.created && admin.password) {
      // Printed once, to the container log only. It is not stored anywhere in
      // plaintext and cannot be recovered later — reset it with
      // `npm run admin:set-password` if it is missed.
      console.log(
        '\n' +
          '  ┌──────────────────────────────────────────────────────────┐\n' +
          '  │  Initial admin account created                           │\n' +
          '  └──────────────────────────────────────────────────────────┘\n' +
          `     username: ${admin.username}\n` +
          `     password: ${admin.password}\n` +
          '     Change it after the first login.\n',
      );
    }
  } catch (cause) {
    console.error('[boot] initialisation failed', cause);
    throw cause;
  }

  logEvent({ stage: 'system', message: 'Application started.' });
  startWorker();
}
