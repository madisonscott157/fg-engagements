# .github/workflows/build-dashboard-data.yml
# Builds dashboard_data.json from Google Sheet after scrapers run

name: Build Dashboard Data

on:
  # Run after other workflows complete
  workflow_run:
    workflows: ["Scrape Engagements", "Scrape Results"]
    types:
      - completed
  
  # Also run on schedule (backup, in case workflow_run misses)
  schedule:
    - cron: '45 6-20 * * *'  # Every hour from 6:45 to 20:45
  
  # Manual trigger
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    # Only run if triggering workflow succeeded (or if manual/scheduled)
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name != 'workflow_run' }}
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm install googleapis
      
      - name: Build dashboard data
        env:
          GOOGLE_SERVICE_ACCOUNT: ${{ secrets.GOOGLE_SERVICE_ACCOUNT }}
          SPREADSHEET_ID: ${{ secrets.SPREADSHEET_ID }}
        run: node build_dashboard_data.js
      
      - name: Commit and push if changed
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"
          git add data/dashboard_data.json
          git diff --staged --quiet || git commit -m "Update dashboard data [skip ci]"
          git push
```

---

## 📁 Summary - File Locations

Make sure your repo structure looks like this:
```
fg-engagements/
├── .github/
│   └── workflows/
│       ├── build-dashboard-data.yml    ← YAML file
│       ├── scrape-engagements.yml
│       └── scrape-results.yml
├── data/
│   └── (dashboard_data.json will be created here)
├── build_dashboard_data.js             ← JavaScript file
├── scrape_engagements.js
└── scrape_results.js
