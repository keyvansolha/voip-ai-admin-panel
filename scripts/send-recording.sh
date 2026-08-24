#!/bin/sh
#
# send-recording.sh — upload one Asterisk call recording to the VoIP AI Manager.
#
# This replaces the script that used to post to the n8n webhook. It is POSIX sh
# (no bashisms) so it runs on whatever the store PC has, and it retries on its
# own because the store's connection drops during power events.
#
# Asterisk hangup handler example (extensions.conf):
#
#   same => n,Set(CDR(recordingfile)=${UNIQUEID})
#   same => n,System(/usr/local/bin/send-recording.sh "${MIXMONITOR_FILENAME}")
#
# Usage:
#   send-recording.sh /var/spool/asterisk/monitor/q-5001-98...-1786882183.3683.wav
#
# Configuration comes from /etc/voip-ai-manager.conf if it exists, otherwise
# from the environment. Required: INGEST_URL, INGEST_TOKEN.

set -eu

CONFIG_FILE="${CONFIG_FILE:-/etc/voip-ai-manager.conf}"
# shellcheck source=/dev/null
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"

INGEST_URL="${INGEST_URL:-}"
INGEST_TOKEN="${INGEST_TOKEN:-}"
LOG_FILE="${LOG_FILE:-/var/log/voip-ai-manager.log}"
SPOOL_DIR="${SPOOL_DIR:-/var/spool/voip-ai-manager}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-5}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-15}"
MAX_TIME="${MAX_TIME:-300}"
# Set KEEP_LOCAL=1 to leave the recording in place after a successful upload.
KEEP_LOCAL="${KEEP_LOCAL:-1}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null || true
}

die() {
  log "ERROR: $*"
  printf 'send-recording.sh: %s\n' "$*" >&2
  exit 1
}

[ -n "$INGEST_URL" ] || die "INGEST_URL is not set (check $CONFIG_FILE)"
[ -n "$INGEST_TOKEN" ] || die "INGEST_TOKEN is not set (check $CONFIG_FILE)"
[ "$#" -ge 1 ] || die "usage: $0 <recording-file>"

RECORDING="$1"
[ -f "$RECORDING" ] || die "no such file: $RECORDING"

BASENAME="$(basename "$RECORDING")"

# Asterisk closes the file after the hangup handler starts, so a moment's wait
# avoids uploading a half-flushed WAV whose data chunk looks empty — which the
# server would classify as a missed call.
sleep "${SETTLE_SECONDS:-2}"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  response="$(
    curl --silent --show-error \
         --connect-timeout "$CONNECT_TIMEOUT" \
         --max-time "$MAX_TIME" \
         --write-out '\n%{http_code}' \
         --request POST \
         --header "X-Ingest-Token: $INGEST_TOKEN" \
         --form "file=@${RECORDING};filename=${BASENAME}" \
         --form "path=${RECORDING}" \
         "$INGEST_URL" 2>&1
  )" || response="$response
000"

  status="$(printf '%s' "$response" | tail -n 1)"
  body="$(printf '%s' "$response" | sed '$d')"

  case "$status" in
    200 | 201 | 202)
      log "OK ($status) $BASENAME -> $body"
      [ "$KEEP_LOCAL" = "1" ] || rm -f "$RECORDING"
      exit 0
      ;;
    401 | 413 | 415 | 422)
      # A bad token or a rejected file will be rejected identically forever.
      log "PERMANENT ($status) $BASENAME -> $body"
      break
      ;;
    *)
      log "RETRY $attempt/$MAX_ATTEMPTS ($status) $BASENAME -> $body"
      sleep $((attempt * 10))
      ;;
  esac

  attempt=$((attempt + 1))
done

# Out of attempts: park the file so nothing is lost while the link is down.
# Re-send the spool with: for f in "$SPOOL_DIR"/*.wav; do send-recording.sh "$f"; done
mkdir -p "$SPOOL_DIR" 2>/dev/null || true
if cp -f "$RECORDING" "$SPOOL_DIR/$BASENAME" 2>/dev/null; then
  log "SPOOLED $BASENAME to $SPOOL_DIR"
else
  log "FAILED to spool $BASENAME — the recording stays at $RECORDING"
fi

exit 1
