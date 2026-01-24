# FG-Engagements

France Galop scraper that monitors horse racing engagements and results, posting updates to Discord.

## What It Does

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| **Scrape Engagements** | Every 2 hrs (6AM-8PM UTC) | Scrapes trainer engagements from France Galop |
| **Scrape Race Results** | Every 10 min (12PM-10PM UTC) | Scrapes race results |
| **Race Alerts** | Every 15 min (10AM-10PM UTC) | Sends Discord alerts before races start |
| **Check Tracking Reports** | Every 5 min (12PM-11PM UTC) | Posts tracking report links after races |
| **Build Dashboard Data** | After scrapers run | Compiles data for dashboard |

## Files

```
├── scrape_engagements.js    # Main engagements scraper
├── scrape_results.js        # Race results scraper
├── scrape_race_alerts.js    # Pre-race Discord alerts
├── check_tracking_reports.js # Post-race tracking reports
├── build_dashboard_data.js  # Dashboard data compiler
├── index.html               # Dashboard UI
├── package.json             # Locked dependencies
├── data/                    # Scraped data (auto-updated)
└── .github/workflows/       # GitHub Actions configs
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

## Fixes Applied (Jan 2026)

### Problem: Playwright Browser Mismatch
The workflows were failing with:
```
browserType.launch: Executable doesn't exist at ~/.cache/ms-playwright/chromium_headless_shell-1208/...
```

**Cause:** No `package.json` meant Playwright updated randomly, but cached browsers didn't match.

**Fix:** Added `package.json` to lock Playwright at v1.49.1.

### Problem: Git Push Conflicts
Multiple workflows running close together would fail on `git push`.

**Fix:**
- Added `concurrency` groups so workflows queue instead of conflict
- Added `git pull --rebase` before commits
- Added retry loop (3 attempts) for push

### Problem: Inefficient Browser Usage
`check_tracking_reports.js` and `scrape_race_alerts.js` opened a new browser for every single request.

**Fix:** Refactored to reuse a single browser instance across all requests.

### Other Cleanups
- Removed stray `scrape_results.js` from workflows folder
- Added `.gitignore` for `node_modules/` and temp files
- Improved error handling with try/finally blocks

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
