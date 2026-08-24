import { headers } from 'next/headers';
import { getTranslator } from '@/lib/i18n';
import {
  AI_PROVIDERS,
  DATETIME_FORMATS,
  getPublicSettings,
  getSettings,
  LOCALES,
} from '@/lib/settings';
import { rotateIngestTokenAction, saveSettingsAction } from '@/app/actions/settings';
import { Alert, Card, PageHeader } from '@/components/ui';
import { CopyField } from '@/components/CopyField';
import { TestConnectionButton } from '@/components/TestConnectionButton';
import {
  CheckboxField,
  SecretField,
  SelectField,
  Section,
  TextField,
} from '@/components/SettingsFields';

export const dynamic = 'force-dynamic';

async function webhookUrl(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? 'localhost:3000';
  const proto =
    headerList.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/api/ingest`;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; rotated?: string }>;
}) {
  const { t } = await getTranslator();
  const { saved, error, rotated } = await searchParams;

  const settings = getSettings();
  const view = getPublicSettings();
  const secretLabels = {
    set: t('settings.secretSet'),
    unset: t('settings.secretUnset'),
    keep: t('settings.secretKeep'),
    clear: t('settings.secretClear'),
  };

  return (
    <>
      <PageHeader title={t('settings.title')} />

      {saved ? (
        <div className="mb-4">
          <Alert tone="ok">{t('settings.saved')}</Alert>
        </div>
      ) : null}
      {rotated ? (
        <div className="mb-4">
          <Alert tone="warn">{t('settings.ingest.rotateConfirm')}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Alert tone="danger" title={t('settings.invalid')}>
            <span dir="ltr">{error}</span>
          </Alert>
        </div>
      ) : null}

      <div className="max-w-3xl space-y-6">
        <Card title={t('settings.section.ingest')}>
          <div className="space-y-4 p-4">
            <CopyField
              label={t('settings.ingest.url')}
              value={await webhookUrl()}
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
            />
            <CopyField
              label={t('settings.ingest.token')}
              value={settings['ingest.token']}
              secret
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
            />
            <p className="field-hint">
              The store PC posts recordings here with this token in an{' '}
              <code className="font-mono">X-Ingest-Token</code> header. See{' '}
              <code className="font-mono">scripts/send-recording.sh</code> in the repository.
            </p>
            <form action={rotateIngestTokenAction}>
              <button type="submit" className="btn btn-sm btn-danger">
                {t('settings.ingest.rotate')}
              </button>
            </form>
          </div>
        </Card>

        <Section
          id="ingest"
          title={`${t('settings.section.ingest')} · ${t('settings.ingest.timezone')}`}
          action={saveSettingsAction}
          booleans={['ingest.requireParsableFilename', 'ingest.ignoreDuplicates']}
          footer={
            <button type="submit" className="btn btn-primary btn-sm">
              {t('settings.save')}
            </button>
          }
        >
          <TextField
            name="ingest.timezone"
            label={t('settings.ingest.timezone')}
            defaultValue={view['ingest.timezone']}
            hint={t('settings.ingest.timezoneHelp')}
          />
          <CheckboxField
            name="ingest.requireParsableFilename"
            label={t('settings.ingest.requireParsable')}
            defaultChecked={view['ingest.requireParsableFilename']}
          />
          <CheckboxField
            name="ingest.ignoreDuplicates"
            label={t('settings.ingest.ignoreDuplicates')}
            defaultChecked={view['ingest.ignoreDuplicates']}
          />
        </Section>

        <Section
          id="ai"
          title={t('settings.section.ai')}
          action={saveSettingsAction}
          booleans={['ai.enabled', 'ai.structuredOutput', 'ai.restrictToPresetTopics']}
          footer={
            <>
              <button type="submit" className="btn btn-primary btn-sm">
                {t('settings.save')}
              </button>
              <TestConnectionButton
                target="ai"
                label={t('settings.ai.test')}
                busyLabel={t('common.testing')}
              />
            </>
          }
        >
          <CheckboxField
            name="ai.enabled"
            label={t('settings.ai.enabled')}
            defaultChecked={view['ai.enabled']}
          />

          <SelectField
            name="ai.provider"
            label={t('settings.ai.provider')}
            defaultValue={view['ai.provider']}
            options={AI_PROVIDERS.map((provider) => ({
              value: provider,
              label: t(`settings.ai.provider.${provider}` as 'settings.ai.provider.vertex'),
            }))}
          />

          <SecretField
            name="ai.apiKey"
            label={t('settings.ai.apiKey')}
            isSet={view.secrets['ai.apiKey']}
            hint={t('settings.ai.apiKeyHelp')}
            labels={secretLabels}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="ai.vertexProject"
              label={t('settings.ai.vertexProject')}
              defaultValue={view['ai.vertexProject']}
              placeholder="my-gcp-project"
            />
            <TextField
              name="ai.vertexLocation"
              label={t('settings.ai.vertexLocation')}
              defaultValue={view['ai.vertexLocation']}
              placeholder="us-central1"
            />
          </div>

          <SecretField
            name="ai.vertexServiceAccountJson"
            label={t('settings.ai.serviceAccount')}
            isSet={view.secrets['ai.vertexServiceAccountJson']}
            hint={t('settings.ai.serviceAccountHelp')}
            labels={secretLabels}
            multiline
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="ai.model"
              label={t('settings.ai.model')}
              defaultValue={view['ai.model']}
            />
            <TextField
              name="ai.temperature"
              label={t('settings.ai.temperature')}
              type="number"
              defaultValue={view['ai.temperature']}
            />
            <TextField
              name="ai.maxOutputTokens"
              label={t('settings.ai.maxOutputTokens')}
              type="number"
              defaultValue={view['ai.maxOutputTokens']}
            />
            <TextField
              name="ai.timeoutMs"
              label={t('settings.ai.timeout')}
              type="number"
              defaultValue={view['ai.timeoutMs']}
            />
          </div>

          <CheckboxField
            name="ai.structuredOutput"
            label={t('settings.ai.structured')}
            defaultChecked={view['ai.structuredOutput']}
          />
          <CheckboxField
            name="ai.restrictToPresetTopics"
            label={t('settings.ai.restrictTopics')}
            defaultChecked={view['ai.restrictToPresetTopics']}
          />
        </Section>

        <Section
          id="audio"
          title={t('settings.section.audio')}
          action={saveSettingsAction}
          booleans={['audio.compressEnabled']}
          footer={
            <button type="submit" className="btn btn-primary btn-sm">
              {t('settings.save')}
            </button>
          }
        >
          <CheckboxField
            name="audio.compressEnabled"
            label={t('settings.audio.compress')}
            defaultChecked={view['audio.compressEnabled']}
            hint={t('settings.audio.compressHelp')}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              name="audio.compressThresholdBytes"
              label={t('settings.audio.threshold')}
              type="number"
              defaultValue={view['audio.compressThresholdBytes']}
            />
            <TextField
              name="audio.targetBitrateKbps"
              label={t('settings.audio.bitrate')}
              type="number"
              defaultValue={view['audio.targetBitrateKbps']}
            />
            <TextField
              name="audio.maxUploadToModelBytes"
              label={t('settings.audio.maxUpload')}
              type="number"
              defaultValue={view['audio.maxUploadToModelBytes']}
            />
          </div>
        </Section>

        <Section
          id="panel"
          title={t('settings.section.panel')}
          action={saveSettingsAction}
          booleans={['panel.enabled', 'panel.pushMissedCalls']}
          footer={
            <>
              <button type="submit" className="btn btn-primary btn-sm">
                {t('settings.save')}
              </button>
              <TestConnectionButton
                target="panel"
                label={t('settings.panel.test')}
                busyLabel={t('common.testing')}
              />
            </>
          }
        >
          <CheckboxField
            name="panel.enabled"
            label={t('settings.panel.enabled')}
            defaultChecked={view['panel.enabled']}
          />
          <TextField
            name="panel.baseUrl"
            label={t('settings.panel.baseUrl')}
            type="url"
            defaultValue={view['panel.baseUrl']}
            hint="Without a path — /api/voip/calls/ and /api/voip/transcripts/ are appended."
          />
          <SecretField
            name="panel.apiToken"
            label={t('settings.panel.token')}
            isSet={view.secrets['panel.apiToken']}
            hint="Sent as the X-API-Key header."
            labels={secretLabels}
          />
          <SelectField
            name="panel.datetimeFormat"
            label={t('settings.panel.datetimeFormat')}
            defaultValue={view['panel.datetimeFormat']}
            options={DATETIME_FORMATS.map((format) => ({
              value: format,
              label: t(
                `settings.panel.datetimeFormat.${format}` as 'settings.panel.datetimeFormat.iso_utc',
              ),
            }))}
          />
          <TextField
            name="panel.timeoutMs"
            label={t('settings.panel.timeout')}
            type="number"
            defaultValue={view['panel.timeoutMs']}
          />
          <CheckboxField
            name="panel.pushMissedCalls"
            label={t('settings.panel.pushMissed')}
            defaultChecked={view['panel.pushMissedCalls']}
          />
        </Section>

        <Section
          id="retention"
          title={t('settings.section.retention')}
          action={saveSettingsAction}
          footer={
            <button type="submit" className="btn btn-primary btn-sm">
              {t('settings.save')}
            </button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              name="retention.recordingDays"
              label={t('settings.retention.recordings')}
              type="number"
              defaultValue={view['retention.recordingDays']}
              hint={t('settings.retention.zeroKeeps')}
            />
            <TextField
              name="retention.logDays"
              label={t('settings.retention.logs')}
              type="number"
              defaultValue={view['retention.logDays']}
            />
            <TextField
              name="retention.callDays"
              label={t('settings.retention.calls')}
              type="number"
              defaultValue={view['retention.callDays']}
            />
          </div>
        </Section>

        <Section
          id="ui"
          title={t('settings.section.ui')}
          action={saveSettingsAction}
          footer={
            <button type="submit" className="btn btn-primary btn-sm">
              {t('settings.save')}
            </button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              name="ui.defaultLocale"
              label={t('settings.ui.locale')}
              defaultValue={view['ui.defaultLocale']}
              options={LOCALES.map((locale) => ({
                value: locale,
                label: locale === 'fa' ? 'فارسی' : 'English',
              }))}
            />
            <TextField
              name="ui.displayTimezone"
              label={t('settings.ui.timezone')}
              defaultValue={view['ui.displayTimezone']}
            />
          </div>
        </Section>

        <Card title="Worker">
          <form action={saveSettingsAction} className="space-y-4 p-4">
            <input type="hidden" name="__section" value="worker" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                name="worker.maxAttempts"
                label="Retry attempts per recording"
                type="number"
                defaultValue={view['worker.maxAttempts']}
              />
              <TextField
                name="worker.pollIntervalMs"
                label="Queue poll interval (ms)"
                type="number"
                defaultValue={view['worker.pollIntervalMs']}
              />
            </div>
            <div className="border-t border-border pt-4">
              <button type="submit" className="btn btn-primary btn-sm">
                {t('settings.save')}
              </button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
