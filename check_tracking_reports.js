// Node 18+ / 20+; CommonJS. ENV: DISCORD_WEBHOOK_RESULTS

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

const WEBHOOK = process.env.DISCORD_WEBHOOK_RESULTS;

if (!WEBHOOK) {
  console.error('Missing DISCORD_WEBHOOK_RESULTS');
  process.exit(1);
}

const STORE_DIR = 'data';
const PENDING_FILE = path.join(STORE_DIR, 'pending_tracking.json');
const POSTED_FILE = path.join(STORE_DIR, 'posted_tracking.json');

async function loadPendingTracking() {
  try {
    const txt = await fs.readFile(PENDING_FILE, 'utf8');
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function savePendingTracking(arr) {
  await fs.writeFile(PENDING_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

async function loadPostedTracking() {
  try {
    const txt = await fs.readFile(POSTED_FILE, 'utf8');
    return new Set(JSON.parse(txt));
  } catch {
    return new Set();
  }
}

async function savePostedTracking(set) {
  const arr = Array.from(set).slice(-500); // keep last 500
  await fs.writeFile(POSTED_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

async function checkForTracking(raceUrl) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto(raceUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Look for tracking report link (PDF with "tracking" or "last_times" in the URL)
    const trackingLinks = page.locator('a[href*="Tracking"], a[href*="last_times"], a:has-text("Tracking"), a:has-text("Rapport")');
    
    if (await trackingLinks.count() > 0) {
      const link = trackingLinks.first();
      let href = await link.getAttribute('href');
      
      if (href) {
        // Make full URL
        if (!href.startsWith('http')) {
          if (href.startsWith('//')) {
            href = 'https:' + href;
          } else if (href.startsWith('/')) {
            href = 'https://www.france-galop.com' + href;
          } else {
            href = 'https://www7.france-galop.com/Casaques/Tracking/' + href;
          }
        }
        
        await browser.close();
        return href;
      }
    }

    await browser.close();
    return null;
  } catch (err) {
    console.error(`Error checking ${raceUrl}:`, err.message);
    await browser.close();
    return null;
  }
}

(async () => {
  let pending = await loadPendingTracking();
  const posted = await loadPostedTracking();
  
  if (pending.length === 0) {
    console.log('No pending tracking reports to check');
    process.exit(0);
  }

  console.log(`Checking ${pending.length} races for tracking reports...`);

  const now = Date.now();
  const FORTY_FIVE_MINUTES = 45 * 60 * 1000;
  const found = [];
  const stillPending = [];

  for (const race of pending) {
    const age = now - race.addedAt;

    // If already posted, skip
    if (posted.has(race.raceUrl)) {
      console.log(`⏭️  ${race.horse} (${race.date}) - already posted, removing from queue`);
      continue;
    }

    // If older than 45 minutes, stop checking (tracking reports appear 15-30 min after race)
    if (age > FORTY_FIVE_MINUTES) {
      console.log(`⏱️  ${race.horse} (${race.date}) - exceeded 45min, removing from queue`);
      continue;
    }

    console.log(`Checking tracking for: ${race.horse} (${race.date})...`);
    const trackingUrl = await checkForTracking(race.raceUrl);

    if (trackingUrl) {
      console.log(`✅ Found tracking report for ${race.horse}!`);
      found.push({ ...race, trackingUrl });
      posted.add(race.raceUrl); // Mark as posted
    } else {
      const ageMinutes = Math.round(age / (60 * 1000));
      console.log(`⏳ No tracking yet for ${race.horse} (age: ${ageMinutes}min)`);
      stillPending.push(race);
    }
  }

  // Post tracking reports to Discord
  for (const r of found) {
    const content = `📊 **RAPPORT DE TRACKING DISPONIBLE**\n• **Cheval:** ${r.horse}\n• **Course:** [${r.date} - ${r.hippodrome}](${r.raceUrl})\n• [**📄 Tracking Report**](${r.trackingUrl})`;

    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });

    if (!res.ok) {
      console.error('Discord webhook failed', await res.text());
    }
  }

  // Save updated pending list and posted list
  await savePendingTracking(stillPending);
  await savePostedTracking(posted);

  console.log(`✅ Posted ${found.length} tracking reports, ${stillPending.length} still pending`);
})();
