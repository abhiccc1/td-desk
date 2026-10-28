#!/bin/sh
set -e

SCRIPT=/app/shared/scripts/sync_fmp_calendar.py
LOG=/var/log/fmp_sync.log
touch "$LOG"

echo "$(date -Iseconds) [entrypoint] Running initial FMP calendar sync..." >> "$LOG"
python "$SCRIPT" >> "$LOG" 2>&1 || true

# Write env vars into a sourceable file (cron doesn't inherit Docker env)
printenv | grep -E '^(REDIS_URL|FMP_API_KEY|TIMESCALEDB_URL|LOG_LEVEL|PYTHONPATH|PATH|HOME)=' \
  | sed 's/^\(.*\)$/export \1/' > /etc/fmp_cron_env

# Install crontab: 9:15 AM, 12:00 PM, 3:00 PM IST (UTC+5:30)
cat > /etc/cron.d/fmp-sync <<CRON
45 3 * * * root . /etc/fmp_cron_env; cd /app && python $SCRIPT >> $LOG 2>&1
30 6 * * * root . /etc/fmp_cron_env; cd /app && python $SCRIPT >> $LOG 2>&1
30 9 * * * root . /etc/fmp_cron_env; cd /app && python $SCRIPT >> $LOG 2>&1
CRON
chmod 0644 /etc/cron.d/fmp-sync

echo "$(date -Iseconds) [entrypoint] Cron installed. Tailing log..." >> "$LOG"

# Start cron daemon then tail log so container stays alive with visible output
cron
exec tail -f "$LOG"
