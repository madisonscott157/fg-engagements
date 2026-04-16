// Node 18+ / 20+; CommonJS. ENV: DISCORD_WEBHOOK_RESULTS
// France Galop login: FRANCE_GALOP_EMAIL, FRANCE_GALOP_PASSWORD

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { ensureLoggedIn, loadSessionStorageState } = require('./lib/fg_login');
const { sendLoginFailureAlert } = require('./lib/fg_alert');

const WEBHOOK = process.env.DISCORD_WEBHOOK_RESULTS;
const FG_EMAIL = process.env.FRANCE_GALOP_EMAIL;
const FG_PASSWORD = process.env.FRANCE_GALOP_PASSWORD;

if (!WEBHOOK) {
  console.error('Missing DISCORD_WEBHOOK_RESULTS');
  process.exit(1);
}

if (!FG_EMAIL || !FG_PASSWORD) {
  console.warn('⚠️ Missing FRANCE_GALOP_EMAIL or FRANCE_GALOP_PASSWORD - login may fail');
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

async function checkForTracking(page, raceUrl) {
  try {
    // Retry page load up to 3 times with increasing delays
    let loaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(raceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        loaded = true;
        break;
      } catch (err) {
        console.log(`  Attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, attempt * 5000));
      }
    }
    await page.waitForTimeout(1500);

    // Dismiss cookie consent popup if present
    for (const sel of [
      'button:has-text("Tout accepter")',
      'button:has-text("Accepter tout")',
      'button:has-text("Accept all")',
    ]) {
      const b = page.locator(sel);
      if (await b.count()) { await b.first().click().catch(()=>{}); break; }
    }
    await page.waitForTimeout(500);

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

        return href;
      }
    }

    return null;
  } catch (err) {
    console.error(`Error checking ${raceUrl}:`, err.message);
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
  const MAX_TRACKING_WAIT = 90 * 60 * 1000;
  const found = [];
  const stillPending = [];

  // Filter races first before launching browser
  const racesToCheck = [];
  for (const race of pending) {
    const age = now - race.addedAt;

    if (posted.has(race.raceUrl)) {
      console.log(`⏭️  ${race.horse} (${race.date}) - already posted, removing from queue`);
      continue;
    }

    if (age > MAX_TRACKING_WAIT) {
      console.log(`⏱️  ${race.horse} (${race.date}) - exceeded 90min, removing from queue`);
      continue;
    }

    racesToCheck.push({ race, age });
  }

  // Only launch browser if we have races to check
  if (racesToCheck.length > 0) {
    const browser = await chromium.launch({ headless: true });
    const storageState = await loadSessionStorageState();
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      storageState,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);

    // Prime the session via /fr/login; if cached cookies are still valid,
    // ensureLoggedIn is a no-op. Otherwise it drives the CIAM flow.
    try {
      await page.goto('https://www.france-galop.com/fr/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await ensureLoggedIn(page, ctx, {
        email: FG_EMAIL,
        password: FG_PASSWORD,
        targetUrl: 'https://www.france-galop.com/fr',
      });
    } catch (err) {
      console.error('❌ France Galop login failed: ' + err.message);
      await sendLoginFailureAlert('check_tracking_reports', err.message, WEBHOOK);
      await browser.close();
      process.exit(1);
    }

    try {
      for (const { race, age } of racesToCheck) {
        console.log(`Checking tracking for: ${race.horse} (${race.date})...`);
        const trackingUrl = await checkForTracking(page, race.raceUrl);

        if (trackingUrl) {
          console.log(`✅ Found tracking report for ${race.horse}!`);
          found.push({ ...race, trackingUrl });
          posted.add(race.raceUrl);
        } else {
          const ageMinutes = Math.round(age / (60 * 1000));
          console.log(`⏳ No tracking yet for ${race.horse} (age: ${ageMinutes}min)`);
          stillPending.push(race);
        }
      }
    } finally {
      await browser.close();
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
