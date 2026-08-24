import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { getSettings } from '@/lib/settings';
import { testAiConnection } from '@/lib/ai/gemini';
import { PanelClient } from '@/lib/panel/client';
import { logEvent } from '@/lib/logger';

/**
 * Credential checks for the Settings page. Tests the *saved* configuration, so
 * the flow is save-then-test rather than testing unsaved form values — which
 * also keeps secrets out of this request body.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in' }, { status: 401 });

  const target = new URL(request.url).searchParams.get('target');
  const settings = getSettings();

  if (target === 'ai') {
    const result = await testAiConnection(settings);
    logEvent({
      stage: 'system',
      level: result.ok ? 'info' : 'warn',
      message: result.ok
        ? `Gemini connection test succeeded (${settings['ai.provider']}, ${settings['ai.model']}).`
        : `Gemini connection test failed: ${result.error}`,
    });
    return NextResponse.json(
      result.ok
        ? { ok: true, message: `${settings['ai.model']} replied: ${result.reply}` }
        : { ok: false, error: result.error },
    );
  }

  if (target === 'panel') {
    try {
      const client = new PanelClient(settings);
      const result = await client.testConnection();
      logEvent({
        stage: 'system',
        level: result.ok ? 'info' : 'warn',
        message: result.ok
          ? `Panel connection test succeeded (${result.count ?? '?'} calls visible).`
          : `Panel connection test failed: ${result.error}`,
      });
      return NextResponse.json(
        result.ok
          ? {
              ok: true,
              message: `Connected. The panel reports ${result.count ?? 'an unknown number of'} existing calls.`,
            }
          : { ok: false, error: result.error },
      );
    } catch (cause) {
      return NextResponse.json({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return NextResponse.json({ ok: false, error: 'Unknown test target' }, { status: 400 });
}
