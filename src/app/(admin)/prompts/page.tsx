import { getTranslator } from '@/lib/i18n';
import { getSettings } from '@/lib/settings';
import { getActivePrompt, listPromptVersions } from '@/lib/ai/prompts';
import { DEFAULT_PROMPTS } from '@/lib/ai/default-prompts';
import { formatLocalDisplay } from '@/lib/time';
import { resetPromptAction, restorePromptAction, savePromptAction } from '@/app/actions/prompts';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; restored?: string; error?: string; key?: string }>;
}) {
  const { t } = await getTranslator();
  const { saved, restored, error } = await searchParams;
  const timezone = getSettings()['ui.displayTimezone'];

  return (
    <>
      <PageHeader title={t('prompts.title')} description={t('prompts.intro')} />

      {saved ? (
        <div className="mb-4">
          <Alert tone="ok">{t('prompts.saved', { version: saved })}</Alert>
        </div>
      ) : null}
      {restored ? (
        <div className="mb-4">
          <Alert tone="ok">{t('prompts.restored', { version: restored })}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Alert tone="danger">{error === 'empty' ? t('prompts.empty') : error}</Alert>
        </div>
      ) : null}

      <div className="space-y-8">
        {DEFAULT_PROMPTS.map((template) => {
          const active = getActivePrompt(template.key);
          const versions = listPromptVersions(template.key);

          return (
            <Card
              key={template.key}
              title={
                <span className="flex items-center gap-2">
                  {template.label}
                  <Badge tone="accent">{t('prompts.version', { version: active.version })}</Badge>
                </span>
              }
            >
              <p className="border-b border-border px-4 py-2 text-xs text-content-muted">
                {template.description}
              </p>

              <form action={savePromptAction} className="space-y-4 p-4">
                <input type="hidden" name="key" value={template.key} />

                <label className="block">
                  <span className="field-label">{t('prompts.system')}</span>
                  <textarea
                    name="systemText"
                    rows={3}
                    defaultValue={active.systemText}
                    className="textarea"
                    dir="auto"
                    required
                  />
                </label>

                <label className="block">
                  <span className="field-label">{t('prompts.user')}</span>
                  <textarea
                    name="userText"
                    rows={22}
                    defaultValue={active.userText}
                    className="textarea"
                    dir="auto"
                    required
                  />
                </label>

                <label className="block">
                  <span className="field-label">{t('prompts.note')}</span>
                  <input name="note" className="input" dir="auto" />
                </label>

                <div className="flex flex-wrap gap-2">
                  <button type="submit" className="btn btn-primary btn-sm">
                    {t('prompts.save')}
                  </button>
                  <button
                    type="submit"
                    formAction={resetPromptAction}
                    className="btn btn-sm"
                    title={t('prompts.reset')}
                  >
                    {t('prompts.reset')}
                  </button>
                </div>
              </form>

              {versions.length > 1 ? (
                <div className="border-t border-border">
                  <h3 className="px-4 py-2 text-xs font-semibold tracking-wide text-content-muted">
                    {t('prompts.versions')}
                  </h3>
                  <ul className="divide-y divide-border">
                    {versions.map((version) => (
                      <li
                        key={version.id}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="font-medium">
                            {t('prompts.version', { version: version.version })}
                          </span>
                          {version.active ? (
                            <Badge tone="ok">{t('prompts.active')}</Badge>
                          ) : null}
                          <span className="ms-2 text-content-faint">
                            {formatLocalDisplay(version.createdAt, timezone)}
                            {version.createdBy ? ` · ${version.createdBy}` : ''}
                          </span>
                          {version.note ? (
                            <p className="mt-0.5 text-content-muted" dir="auto">
                              {version.note}
                            </p>
                          ) : null}
                        </div>

                        {!version.active ? (
                          <form action={restorePromptAction}>
                            <input type="hidden" name="key" value={template.key} />
                            <input type="hidden" name="version" value={version.version} />
                            <button type="submit" className="btn btn-sm">
                              {t('prompts.restore')}
                            </button>
                          </form>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </>
  );
}
