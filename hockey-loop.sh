#!/usr/bin/env bash
# One GitHub Actions run = a refresh loop every 15 min for up to ~5.5 h.
# GitHub often drops scheduled runs, so each run hands off to the next one itself
# (workflow_dispatch at the end). Crons stay only as a backup to restart the chain.
# Overnight (07-14 UTC) the loop idles without refreshing.
set -u
END=$(( $(date +%s) + ${LOOP_MIN:-330} * 60 ))
EVERY=${EVERY_SEC:-900}
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
FILES="hockey.json hockey-picks.json hockey-edge-cache.json hockey-season-cache.json hockey-teams.json hockey-shots.json hockey-backtest.json hockey-matchups.json hockey-h2h.json hockey-goalies.json hockey-special.json hockey-teamlog.json hockey-box.json hockey-names-cache.json"
while :; do
  H=$(date -u +%H)
  if [ "$H" -ge 7 ] && [ "$H" -lt 14 ]; then
    echo "overnight, idle $(date -u +%T)"
    [ $(( $(date +%s) + EVERY )) -ge "$END" ] && break
    sleep "$EVERY"; continue
  fi
  echo "=== refresh $(date -u +%FT%TZ)"
  git pull -q --rebase -X theirs origin main || true
  node hockey-season-fetch.mjs || echo "season fetch failed"
  if [ "$(cat .season-new 2>/dev/null || echo 0)" != "0" ] || [ ! -f hockey-teams.json ] || [ ! -f hockey-goalies.json ] || [ ! -f hockey-special.json ] || [ ! -f hockey-teamlog.json ]; then node hockey-season-build.mjs || echo "season build failed"; fi
  node hockey-box-build.mjs || echo "box build failed"
  node refresh-hockey.mjs || echo "refresh failed"
  git add $FILES
  if ! git diff --cached --quiet; then
    git commit -q -m "hockey refresh $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    for i in 1 2 3 4 5; do git pull -q --rebase -X theirs origin main && git push -q && break || { echo "retry $i"; sleep 5; }; done
    for i in 1 2 3 4 5; do
      git pull -q --rebase origin main
      SHA=$(git rev-parse HEAD); NOW=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
      printf '{\n  "latestSha": "%s",\n  "updatedAt": "%s",\n  "updatedBy": "refresh-hockey"\n}\n' "$SHA" "$NOW" > version.json
      git add version.json
      if git diff --cached --quiet; then break; fi
      git commit -q -m "version.json: pin ${SHA:0:7}"
      git push -q && break || sleep 5
    done
  else echo "no changes"; fi
  [ $(( $(date +%s) + EVERY )) -ge "$END" ] && break
  sleep "$EVERY"
done

# hand off to the next run so coverage never depends on GitHub's cron
if [ -n "${GH_TOKEN:-}" ]; then
  gh workflow run hockey.yml --ref main && echo "next run dispatched" || echo "dispatch failed (cron backup will restart)"
fi
