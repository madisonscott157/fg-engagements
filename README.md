# FG-Engagements

France Galop scraper that monitors horse racing engagements and results, posting updates to Discord.

## What It Does

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| **Scrape Engagements** | Every 2 hrs (6AM-8PM UTC) + 10:35 & 12:35 Paris | Scrapes trainer engagements, posts Discord twice daily |
| **Scrape Race Results** | Every 10 min (12PM-10PM UTC) | Scrapes race results |
| **Race Alerts** | Every 10 min (10AM-10PM UTC) | Sends Discord alerts 5-30 min before races |
| **Check Tracking Reports** | Every 5 min (12PM-11PM UTC) | Posts tracking report links after races |
| **Build Dashboard Data** | After scrapers run | Compiles data for dashboard |

### Discord Posting Schedule

Engagements are scraped every 2 hours but Discord messages are batched and sent **twice daily at 10:35 AM and 12:35 PM Paris time**. This uses timezone-aware scheduling so times are correct year-round (handles DST automatically). Changes accumulate in `data/pending_discord.json` between posts.

## Files

```
├── scrape_engagements.js      # Main engagements scraper + Discord batching
├── scrape_results.js          # Race results scraper
├── scrape_race_alerts.js      # Pre-race Discord alerts (caches post times)
├── check_tracking_reports.js  # Post-race tracking reports (90 min window)
├── build_dashboard_data.js    # Dashboard data compiler
├── index.html                 # Dashboard UI
├── package.json               # Locked dependencies
├── data/                      # Scraped data (auto-updated)
│   ├── pending_discord.json   # Accumulated Discord changes between posts
│   └── ...                    # Other state files
└── .github/workflows/         # GitHub Actions configs
```

## How It Works

1. **GitHub Actions** runs the scrapers on schedule
2. Scrapers use **Playwright** to load France Galop pages
3. Data is saved to `data/` folder and committed back to repo
4. Updates are posted to **Discord** via webhooks
5. Optionally syncs to **Google Sheets/Docs**

## Required Secrets (GitHub Settings > Secrets)

- `TRAINER_URL` - France Galop trainer page URL
- `RESULTS_URL` - France Galop results page URL
- `DISCORD_WEBHOOK_URL` - Discord webhook for engagements
- `DISCORD_WEBHOOK_RESULTS` - Discord webhook for results
- `DISCORD_WEBHOOK_RACE_ALERTS` - Discord webhook for race alerts
- `GOOGLE_SERVICE_ACCOUNT` - Google API credentials (optional)
- `SPREADSHEET_ID` - Google Sheet ID (optional)
- `DOC_ID` - Google Doc ID (optional)

## Fixes Applied

### Feb 2026 — Discord Batching & Reliability

- **Discord batching:** Engagements scraper accumulates changes and posts to Discord twice daily (10:35 AM / 12:35 PM Paris) instead of on every scrape run
- **Timezone-aware posting:** Uses `Intl.DateTimeFormat` with `Europe/Paris` so posting times are correct year-round regardless of DST
- **Split concurrency groups:** Engagements, race alerts, and results/tracking workflows no longer block each other
- **Race alerts caching:** Post times are cached in `stored_races.json` — only new races trigger a browser fetch
- **Race alerts data preservation:** Failed post time fetches no longer overwrite previously stored data
- **Race alerts future races:** Post times now fetched for all upcoming races, not just today's
- **Race alerts wide window:** Alerts sent 5-30 min before race (25-min window) to handle unreliable GitHub Actions scheduling
- **Tracking window:** Increased from 45 to 90 minutes to catch slower-to-appear tracking reports
- **Null guard:** `filterPastRaces` no longer crashes on races missing post time data

### Jan 2026 — Initial Stability

- Locked Playwright at v1.49.1 via `package.json` to fix browser cache mismatches
- Added concurrency groups and git retry logic for push conflicts
- Refactored browser usage to reuse single instance per run
- Added `.gitignore`, improved error handling

## Manual Testing

1. Go to: https://github.com/madisonscott157/fg-engagements/actions
2. Click any workflow
3. Click "Run workflow" button
4. Check the logs for success/errors

## Local Development

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Run a scraper (needs env vars)
TRAINER_URL="..." DISCORD_WEBHOOK_URL="..." node scrape_engagements.js
```
