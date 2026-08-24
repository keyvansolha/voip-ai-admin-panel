# VoIP AI Manager

Self-hosted ingestion API and admin panel for Asterisk call recordings.

A recording is posted to a webhook, parsed, analysed by Gemini, and delivered to
a downstream VoIP dashboard — with a web UI to configure credentials, edit the
prompts, and see exactly what happened to every file.

This replaces an n8n workflow that did the same job but was locked to a single
Gemini access method and hard to change.

---

## What it does

```
  Asterisk (in-store PC)                 This app (server)                    Downstream panel
 ┌────────────────────────┐            ┌─────────────────────────┐          ┌──────────────────┐
 │ hangup handler         │            │ POST /api/ingest        │          │ POST /calls/     │
 │   └─ send-recording.sh │──── WAV ──▶│   parse filename        │          │ POST /transcripts/│
 │      + X-Ingest-Token  │            │   read WAV chunks       │          └──────────────────┘
 └────────────────────────┘            │   detect missed call    │                    ▲
                                       │   save file, queue job  │                    │
                                       └───────────┬─────────────┘                    │
                                                   │                                  │
                                       ┌───────────▼─────────────┐                    │
                                       │ background worker       │                    │
                                       │   ffmpeg → mono MP3     │                    │
                                       │   Gemini (key or Vertex)│                    │
                                       │   normalise JSON        │────────────────────┘
                                       │   push, with retries    │
                                       └─────────────────────────┘
```

**Three branches, matching the original workflow:**

| Recording                              | Prompt                     | Delivered                        |
| -------------------------------------- | -------------------------- | -------------------------------- |
| Missed (0 bytes, or empty `data` chunk) | none — AI is skipped       | call row only, `missed: true`    |
| Inbound (`in`, `q`)                     | customer prompt (مشتری / فروشنده) | call row + transcript     |
| Outbound / internal (`out`, `exten`)    | coworker prompt (named / role / گوینده N) | call row + transcript |

**In the panel:** dashboard with queue and error state, searchable call list,
per-call page with audio playback, transcript, raw model output and full event
timeline, versioned prompt editor with rollback, and a settings page covering
Gemini credentials, audio compression, delivery format and retention.

Interface is available in English and Persian (RTL), switchable per browser.

---

## Requirements

- **Docker** (recommended) — everything including ffmpeg is in the image
- or **Node.js 20.11+** and **ffmpeg** on the host

---

## Quick start (Docker)

```bash
cp .env.example .env
printf 'APP_SECRET=%s\n' "$(openssl rand -base64 48)" >> .env

docker compose up -d --build
docker compose logs -f app        # the first-run admin password is printed here
```

The panel is on `http://127.0.0.1:3000`. It binds to loopback by design — put a
TLS-terminating reverse proxy in front of it. A minimal Caddy config:

```caddyfile
voip.example.com {
    reverse_proxy 127.0.0.1:3000
    request_body {
        max_size 200MB          # must be at least MAX_UPLOAD_BYTES
    }
}
```

> **Do not expose port 3000 directly.** The ingest token travels in a header, so
> plain HTTP would leak it on every upload.

### Then, in the panel

1. **Settings → Gemini** — choose an access method, paste credentials, save,
   press *Test connection*.
2. **Settings → Downstream panel** — set the base URL and API key, save, test.
3. **Settings → Ingestion webhook** — copy the URL and the ingest token.

### Finally, on the store PC

```bash
sudo install -m 755 scripts/send-recording.sh /usr/local/bin/
sudo tee /etc/voip-ai-manager.conf >/dev/null <<'EOF'
INGEST_URL=https://voip.example.com/api/ingest
INGEST_TOKEN=paste-the-token-from-the-panel
EOF
sudo chmod 600 /etc/voip-ai-manager.conf
```

Point your hangup handler at it:

```
same => n,System(/usr/local/bin/send-recording.sh "${MIXMONITOR_FILENAME}")
```

Verify before wiring it up:

```bash
curl -H "X-Ingest-Token: $TOKEN" https://voip.example.com/api/ingest
# {"success":true,"message":"Ingest endpoint is reachable and the token is valid."}
```

If the network drops, the script retries with backoff and then parks the file in
`/var/spool/voip-ai-manager` rather than losing it. Replay the spool with:

```bash
for f in /var/spool/voip-ai-manager/*.wav; do
  /usr/local/bin/send-recording.sh "$f" && rm -f "$f"
done
```

---

## Local development

```bash
npm install
cp .env.example .env
printf 'APP_SECRET=%s\n' "$(openssl rand -base64 48)" >> .env
npm run dev
```

```bash
npm test          # unit tests for filename, WAV, timezone and JSON handling
npm run typecheck
npm run build
```

---

## Choosing how to reach Gemini

**Gemini API key** — get one from AI Studio, paste it into Settings. Simplest,
billed against the key.

**Vertex AI** — spends Google Cloud credit. Two ways to authenticate:

- Paste a service-account JSON into Settings. It is encrypted with `APP_SECRET`
  before it is stored. Grant the account the *Vertex AI User* role.
- Leave the JSON blank and rely on ambient Application Default Credentials:
  `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or
  the metadata server on a GCE/Cloud Run host.

Set the project id and region either way. Both methods use the same model
setting, so switching between them changes nothing else.

---

## How the pieces work

### Filenames

```
q-5001-989912107914-20260816-163959-1786882183.3683.wav
│ │    │            │        │      │          └── ast_unique_seq
│ │    │            │        │      └───────────── uid
│ │    │            │        └──────────────────── HHMMSS, store-local
│ │    │            └───────────────────────────── YYYYMMDD, store-local
│ │    └────────────────────────────────────────── field 2
│ └─────────────────────────────────────────────── field 1
└───────────────────────────────────────────────── type
```

| Type    | Direction | Customer number |
| ------- | --------- | --------------- |
| `in`    | inbound   | field 1         |
| `q`     | inbound   | field 2         |
| `out`   | outbound  | field 1         |
| `exten` | internal  | field 2         |

### Timestamps

The clock in the filename is **local time on the Asterisk box**. The zone is set
in *Settings → Ingestion webhook* (default `Asia/Tehran`) and resolved through
the IANA database rather than a hardcoded offset, so a future DST policy change
does not silently shift every call by an hour.

The downstream panel is sent ISO-8601 **with an explicit offset** —
`2026-08-16T16:39:59+03:30` — which is what its documentation asks for. The
offset is never added to the clock time; both describe the same instant.
`processing_date` is sent date-only, as its `DateField` requires.

### Duration and missed calls

Duration comes from walking the RIFF chunk table (`byteRate` from `fmt `,
payload size from `data`) rather than assuming audio starts at byte 44 —
Asterisk files often carry `LIST`/`JUNK` chunks first.

A call is missed when the file is 0 bytes, or is a valid WAV whose `data` chunk
is empty. Deliberately *not* keyed on `duration == 0`: an unparseable file also
has duration 0, and treating that as "missed" would discard a real conversation
instead of surfacing the problem.

### Audio compression

Asterisk writes 8 kHz mono PCM — roughly 1 MB per minute — so a long call
exceeds the inline request limit. Files at or above the configured threshold are
re-encoded to 16 kHz mono MP3 with ffmpeg, typically ~30x smaller with no
meaningful loss for speech. If ffmpeg fails and the original is small enough, it
is sent as-is and a warning is logged.

### Retries

Work runs on a SQLite-backed queue inside the app process. Failures are
classified: a 5xx, a timeout or a rate limit is retried with exponential backoff
(30s → 2m → 8m → 32m → 1h); a bad API key or a rejected field is not, because it
would fail identically forever.

Retries resume rather than restart. A call whose analysis succeeded but whose
delivery failed is not re-sent to Gemini — you are not billed twice for a panel
outage. Duplicate uploads are recognised by the Asterisk `uid.seq` pair, and a
409 from the panel is resolved by looking up the existing record.

---

## Configuration

Only infrastructure lives in the environment. Everything operational is in the
panel under Settings.

| Variable             | Default             | Purpose                                                     |
| -------------------- | ------------------- | ----------------------------------------------------------- |
| `APP_SECRET`         | **required**        | Encrypts stored secrets, signs session cookies               |
| `ADMIN_USERNAME`     | `admin`             | First-run admin (only when no users exist)                   |
| `ADMIN_PASSWORD`     | generated           | First-run password; printed to the log if not set            |
| `DATA_DIR`           | `./data`            | Database and recordings root                                 |
| `DATABASE_PATH`      | `$DATA_DIR/app.db`  | SQLite file                                                  |
| `RECORDINGS_DIR`     | `$DATA_DIR/recordings` | Stored audio                                              |
| `WORKER_ENABLED`     | `true`              | Set `false` for a UI-only replica                            |
| `WORKER_CONCURRENCY` | `2`                 | Recordings analysed at once                                  |
| `MAX_UPLOAD_BYTES`   | `209715200`         | Ingest size limit                                            |
| `FFMPEG_PATH`        | `ffmpeg`            | ffmpeg binary                                                |
| `TRUST_PROXY`        | `false`             | `true` behind a TLS-terminating proxy on plain HTTP          |

> Rotating `APP_SECRET` makes every stored credential unreadable and signs
> everyone out. The app degrades gracefully — secrets show as "not set" — but you
> must re-enter them. Back it up alongside the data volume.

---

## API

### `POST /api/ingest`

Header `X-Ingest-Token` (also accepted: `X-API-Key`, `Authorization: Bearer`).
Body `multipart/form-data`.

| Field                | Required | Notes                                            |
| -------------------- | -------- | ------------------------------------------------ |
| `file`               | yes      | The recording. `data`, `recording`, `audio` also work |
| `filename`           | no       | Overrides the multipart filename                 |
| `path`               | no       | Original path on the Asterisk box                |

```bash
curl -X POST https://host/api/ingest \
  -H "X-Ingest-Token: $TOKEN" \
  -F "file=@q-5001-989912107914-20260816-163959-1786882183.3683.wav"
```

```jsonc
// 202 Accepted
{
  "success": true,
  "duplicate": false,
  "ingest_id": "5e2c…",
  "call_id": 412,
  "direction": "inbound",
  "missed": false,
  "duration_sec": 184,
  "recording_datetime": "2026-08-16T16:39:59",
  "status": "received"
}
```

| Status | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| 202    | Accepted and queued                                         |
| 200    | Duplicate — already received; safe to stop retrying         |
| 401    | Bad or missing token                                        |
| 413    | Over `MAX_UPLOAD_BYTES`                                     |
| 415    | Not `multipart/form-data`                                   |
| 422    | Filename rejected (only when strict filenames are enabled)  |
| 500    | Server error — retry                                        |

`GET /api/ingest` with the same header is a token check that sends no file.

### `GET /api/health`

Unauthenticated. Reports database reachability, worker state and queue depth —
no configuration, no credentials.

---

## Operations

**Backup** — everything is in one volume:

```bash
docker compose exec app sqlite3 /data/app.db ".backup '/data/backup.db'"
docker run --rm -v voip-data:/data -v "$PWD":/out alpine \
  tar czf /out/voip-backup.tar.gz -C /data .
```

**Lost the admin password:**

```bash
docker compose exec app node -e "require('./scripts/set-admin-password.js')" admin
# or, from a source checkout:
npm run admin:set-password -- admin
```

**Where to look when something breaks:**

| Symptom                        | Look at                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| Nothing arrives                | `/var/log/voip-ai-manager.log` on the store PC; `GET /api/ingest` |
| Calls stuck in queue           | Dashboard → Worker; `/api/health`                           |
| Analysis fails                 | Call page → Raw model output; Settings → Test connection    |
| Delivery fails                 | Call page → Delivery; check the trailing slash and the key  |
| Everything says "not set"      | `APP_SECRET` changed — re-enter credentials                 |

---

## Project layout

```
src/
  app/
    api/ingest/            the webhook that replaced n8n
    api/recordings/[id]/   authenticated audio streaming, with Range support
    api/health/            liveness probe
    api/admin/test/        credential checks for the Settings page
    (admin)/               dashboard, calls, prompts, logs, settings, account
    actions/               server actions
  lib/
    asterisk/filename.ts   filename → direction, phone, timestamp
    audio/wav.ts           RIFF chunk reader, missed-call detection
    audio/transcode.ts     ffmpeg compression
    ai/                    prompts (versioned), Gemini client, response normaliser
    panel/client.ts        downstream ingestion API client
    pipeline/process.ts    the per-call pipeline
    queue/                 SQLite-backed job queue
    worker/                background loop and retention sweeps
    db/                    schema and migrations
    i18n/                  en / fa dictionaries
  components/
scripts/
  send-recording.sh        for the store PC
tests/
reference/                 original n8n code and notes (gitignored)
```

## License

MIT
