# MatrixBaseball — Live Data Repo

This repo runs the MatrixBaseball MLB data refresh on GitHub Actions every hour and commits the updated `slates.json` back to the repo. The live site at https://enterthematrixprop.pplx.app fetches `slates.json` from this repo via raw.githubusercontent.com on every page load.

## Files

- `scripts/refresh-statcast.mjs` — pulls MLB schedule + lineups + season/L7/L15/L30 stats + Baseball Savant Statcast leaderboards + batter-vs-pitcher history. Writes `slates.json` at the repo root.
- `.github/workflows/refresh.yml` — runs the script every hour and commits the updated file.
- `slates.json` — the live data the site reads. Auto-updated.

## How to run manually

From the GitHub UI: Actions tab → "Refresh MatrixBaseball slates" → "Run workflow".

From your laptop: `node scripts/refresh-statcast.mjs` (requires Node 18+).

## Live URL

After the first successful run, the data is available at:

```
https://raw.githubusercontent.com/<your-username>/<your-repo-name>/main/slates.json
```

The MatrixBaseball site uses that URL as its data source.
