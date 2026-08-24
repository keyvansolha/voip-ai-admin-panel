#!/bin/sh
#
# send-recording.sh — upload one Asterisk call recording to the VoIP AI Manager.
#
# Replaces the script that used to POST to the n8n webhook. POSIX sh, no
# bashisms, so it runs on whatever the store PC has.
#
# Two things it does that a plain `curl` in a hangup handler does not:
#
#   * It detaches immediately. A hangup handler runs on the channel thread, so
#     a synchronous upload holds the channel open for as long as the transfer
#     takes — and with retries, that could be minutes.
#   * It retries with backoff and then parks the file in a spool directory, so
#     a power cut or a dropped link does not lose the recording.
#
# Asterisk hangup handler:
#
#   same => n,System(/usr/local/bin/send-recording.sh "${MIXMONITOR_FILENAME}")
#
# A bare filename is resolved against MONITOR_DIR, matching how Asterisk hands
# out ${MIXMONITOR_FILENAME}.
#
# Usage:
#   send-recording.sh <recording-file|bare-name>
#   send-recording.sh --flush          # retry everything in the spool
#
# Configuration comes from /etc/voip-ai-manager.conf if present, otherwise from
# the environment. Required: INGEST_URL, INGEST_TOKEN.

set -eu

CONFIG_FILE="${CONFIG_FILE:-/etc/voip-ai-manager.conf}"
# `[ -f x ] && . x` would return 1 when the file is absent, and under `set -e`
# that silently kills the script. Every conditional here is an `if` for that
# reason -- do not "simplify" them back to && one-liners.
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  . "$CONFIG_FILE"
fi

# The two required settings. Either leave them empty and put the values in
# CONFIG_FILE (better: that file can be chmod 600, while this script usually is
# not), or fill the defaults in right here:
#
#   INGEST_URL="${INGEST_URL:-https://voip.example.com/api/ingest}"
#   INGEST_TOKEN="${INGEST_TOKEN:-paste-the-token-here}"
#
# A value from CONFIG_FILE or the environment always wins over the default.
INGEST_URL="${INGEST_URL:-}"
INGEST_TOKEN="${INGEST_TOKEN:-}"
MONITOR_DIR="${MONITOR_DIR:-/var/spool/asterisk/monitor}"
SPOOL_DIR="${SPOOL_DIR:-/var/spool/voip-ai-manager}"
LOG_FILE="${LOG_FILE:-/var/log/voip-ai-manager.log}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-5}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-15}"
MAX_TIME="${MAX_TIME:-600}"
# Asterisk closes the recording as the hangup handler starts; a moment's pause
# avoids uploading a half-flushed WAV whose data chunk still looks empty, which
# the server would classify as a missed call.
SETTLE_SECONDS="${SETTLE_SECONDS:-2}"
# Set to 0 to delete the local recording once it has been accepted.
KEEP_LOCAL="${KEEP_LOCAL:-1}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Detach from the channel thread.
#
# Asterisk may signal the whole process group when the channel goes away, so
# setsid is used where available to get a fresh session that survives it.
# ---------------------------------------------------------------------------
if [ "${VOIP_DETACHED:-0}" != "1" ] && [ "${1:-}" != "--flush" ]; then
  VOIP_DETACHED=1
  export VOIP_DETACHED
  # Re-exec through /bin/sh explicitly: invoking "$0" directly would require
  # the executable bit, which is not guaranteed.
  if command -v setsid >/dev/null 2>&1; then
    setsid /bin/sh "$0" "$@" >/dev/null 2>&1 &
  else
    nohup /bin/sh "$0" "$@" >/dev/null 2>&1 &
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# upload <file> — echoes "ok", "permanent" or "retry"
# ---------------------------------------------------------------------------
upload() {
  _file="$1"
  _name="$(basename "$_file")"

  _response="$(
    curl --silent --show-error \
         --connect-timeout "$CONNECT_TIMEOUT" \
         --max-time "$MAX_TIME" \
         --write-out '\n%{http_code}' \
         --request POST \
         --header "X-Ingest-Token: $INGEST_TOKEN" \
         --form "file=@${_file};filename=${_name}" \
         --form "path=${_file}" \
         "$INGEST_URL" 2>&1
  )" || _response="$_response
000"

  _status="$(printf '%s' "$_response" | tail -n 1)"
  _body="$(printf '%s' "$_response" | sed '$d')"

  case "$_status" in
    200 | 201 | 202)
      log "OK ($_status) $_name -> $_body"
      echo ok
      ;;
    401 | 413 | 415 | 422)
      # A bad token or a rejected file fails identically forever.
      log "PERMANENT ($_status) $_name -> $_body"
      echo permanent
      ;;
    *)
      log "RETRY ($_status) $_name -> $_body"
      echo retry
      ;;
  esac
}

# ---------------------------------------------------------------------------
# --flush — re-send everything parked in the spool. Safe to run from cron:
# the server recognises a duplicate by the Asterisk uid.seq pair and answers
# 200, so a file that did arrive is simply cleared.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--flush" ]; then
  [ -n "$INGEST_URL" ] || { echo "INGEST_URL is not set" >&2; exit 1; }
  [ -n "$INGEST_TOKEN" ] || { echo "INGEST_TOKEN is not set" >&2; exit 1; }
  [ -d "$SPOOL_DIR" ] || exit 0

  sent=0
  kept=0
  for spooled in "$SPOOL_DIR"/*; do
    [ -f "$spooled" ] || continue
    case "$(upload "$spooled")" in
      ok | permanent) rm -f "$spooled"; sent=$((sent + 1)) ;;
      *) kept=$((kept + 1)) ;;
    esac
  done

  if [ "$sent" -gt 0 ]; then
    log "FLUSH cleared $sent file(s), $kept still pending"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Normal path: one recording, handed over by the hangup handler.
# ---------------------------------------------------------------------------

# Exit quietly on a missing argument or file. Asterisk calls this on every
# hangup, including calls that were never recorded; a noisy failure there is
# worse than silence.
[ "$#" -ge 1 ] || exit 0
FILEPATH="$1"
[ -n "$FILEPATH" ] || exit 0

# ${MIXMONITOR_FILENAME} is often a bare name; resolve it like Asterisk does.
case "$FILEPATH" in
  /*) ;;
  *) FILEPATH="${MONITOR_DIR%/}/${FILEPATH}" ;;
esac

[ -f "$FILEPATH" ] || { log "SKIP no such file: $FILEPATH"; exit 0; }

if [ -z "$INGEST_URL" ] || [ -z "$INGEST_TOKEN" ]; then
  log "ERROR INGEST_URL or INGEST_TOKEN is not set (check $CONFIG_FILE)"
  exit 1
fi

if [ "${SETTLE_SECONDS:-0}" -gt 0 ] 2>/dev/null; then
  sleep "$SETTLE_SECONDS"
fi

BASENAME="$(basename "$FILEPATH")"
attempt=1

while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  case "$(upload "$FILEPATH")" in
    ok)
      [ "$KEEP_LOCAL" = "1" ] || rm -f "$FILEPATH"
      exit 0
      ;;
    permanent)
      break
      ;;
    *)
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        sleep $((attempt * 10))
      fi
      ;;
  esac
  attempt=$((attempt + 1))
done

# Out of attempts: park a copy so nothing is lost while the link is down.
# Clear it later with: send-recording.sh --flush
if mkdir -p "$SPOOL_DIR" 2>/dev/null && cp -f "$FILEPATH" "$SPOOL_DIR/$BASENAME" 2>/dev/null; then
  log "SPOOLED $BASENAME to $SPOOL_DIR"
else
  log "FAILED to spool $BASENAME — the recording stays at $FILEPATH"
fi

exit 1
