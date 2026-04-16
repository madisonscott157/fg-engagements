// Node 18+ / 20+; CommonJS. ENV: DISCORD_WEBHOOK_RACE_ALERTS
// France Galop login: FRANCE_GALOP_EMAIL, FRANCE_GALOP_PASSWORD

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { ensureLoggedIn, loadSessionStorageState } = require('./lib/fg_login');
const { sendLoginFailureAlert } = require('./lib/fg_alert');

const WEBHOOK = process.env.DISCORD_WEBHOOK_RACE_ALERTS;

// France Galop login credentials
const FG_EMAIL = process.env.FRANCE_GALOP_EMAIL;
const FG_PASSWORD = process.env.FRANCE_GALOP_PASSWORD;

if (!WEBHOOK) {
  console.error('Missing DISCORD_WEBHOOK_RACE_ALERTS');
  process.exit(1);
}

if (!FG_EMAIL || !FG_PASSWORD) {
  console.warn('⚠️ Missing FRANCE_GALOP_EMAIL or FRANCE_GALOP_PASSWORD - login may fail');
}

const STORE_DIR = 'data';
const ALERTS_FILE = path.join(STORE_DIR, 'sent_alerts.json');
const RACES_FILE = path.join(STORE_DIR, 'stored_races.json');
const DPP_FILE = path.join(STORE_DIR, 'dpp_races.json');

// Alert window: send alerts between these times before race
// cron-job.org triggers every 5 min with ~1s jitter, workflow takes ~2-3 min to start
const ALERT_WINDOW_START = 20; // Start alerting 20 min before race
const ALERT_WINDOW_END = 5;    // Stop alerting 5 min before race

const norm = (s) =>
  (s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[']/g, "'")
    .trim();

async function loadSentAlerts() {
  try {
    const txt = await fs.readFile(ALERTS_FILE, 'utf8');
    return new Set(JSON.parse(txt));
  } catch {
    await fs.mkdir(STORE_DIR, { recursive: true });
    return new Set();
  }
}

async function saveSentAlerts(set) {
  const arr = Array.from(set).slice(-200); // keep last 200
  await fs.writeFile(ALERTS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

async function loadStoredRaces() {
  try {
    const txt = await fs.readFile(RACES_FILE, 'utf8');
    return JSON.parse(txt);
  } catch {
    return { lastUpdate: null, races: [] };
  }
}

async function saveStoredRaces(data) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(RACES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Get current time in Paris timezone
function getParisTime() {
  const now = new Date();
  const parisTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const parts = {};
  parisTime.forEach(p => { parts[p.type] = p.value; });
  
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour),
    minute: parseInt(parts.minute),
    formatted: `${parts.hour}:${parts.minute.padStart(2, '0')}`,
    timestamp: now.toISOString(),
  };
}

async function shouldUpdateRaceData() {
  // Check if we have DPP races that need post times fetched
  let dppRaces = [];
  try {
    const dppTxt = await fs.readFile(DPP_FILE, 'utf8');
    const dppData = JSON.parse(dppTxt);
    dppRaces = dppData.races || [];
  } catch {
    console.log('📋 dpp_races.json not found - nothing to update');
    return false;
  }

  if (dppRaces.length === 0) {
    console.log('📋 No races in dpp_races.json');
    return false;
  }

  console.log(`📋 Found ${dppRaces.length} DP-P races in dpp_races.json`);

  // Check if stored_races.json has these races with post times
  let storedRaces = [];
  try {
    const storedTxt = await fs.readFile(RACES_FILE, 'utf8');
    const storedData = JSON.parse(storedTxt);
    storedRaces = storedData.races || [];
  } catch {
    console.log('📋 stored_races.json not found or empty - will update');
    return true;
  }

  // Check if ALL DPP races are in stored_races with post times (not just today's)
  const storedUrls = new Set(storedRaces.filter(r => r.postTime).map(r => r.raceUrl));
  const missingRaces = dppRaces.filter(r => r.raceUrl && !storedUrls.has(r.raceUrl));

  if (missingRaces.length > 0) {
    console.log(`📋 ${missingRaces.length} races missing post times - will update`);
    return true;
  }

  console.log('📋 All races already have post times - using stored data');
  return false;
}

function parseRaceDate(dateStr) {
  // Parse "30/10/2025" format
  const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  
  const [, day, month, year] = match;
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

function filterPastRaces(races, parisTime) {
  const today = new Date(parisTime.date);
  const currentMinutes = parisTime.hour * 60 + parisTime.minute;

  return races.filter(race => {
    const raceDate = parseRaceDate(race.date);
    if (!raceDate) return false;

    // Skip races without post time data
    if (!race.postTime) return false;

    // If race is on a future date, keep it
    if (raceDate > today) return true;

    // If race is today, check if post time has passed
    if (raceDate.toDateString() === today.toDateString()) {
      const raceMinutes = race.postTime.hour * 60 + race.postTime.minute;
      return raceMinutes > currentMinutes;
    }

    // Race is in the past
    return false;
  });
}

async function loadDPPRaces() {
  console.log('📖 Reading DPP races from engagements scraper data...');
  
  try {
    const txt = await fs.readFile(DPP_FILE, 'utf8');
    const data = JSON.parse(txt);
    
    console.log(`✅ Found ${data.races.length} DP-P horses (last updated: ${data.lastUpdate})`);
    return data.races;
    
  } catch (err) {
    console.error('❌ Error reading DPP races data:', err.message);
    console.log('ℹ️  This is expected if engagements scraper hasn\'t run yet today');
    return null;
  }
}

// Defensive re-login used inside the per-race fetch loop.
// Proactive login (and its loud alert) already ran in updateRaceData(), so
// this path stays silent to avoid one-alert-per-race spam if a session dies
// mid-run; the calling loop will just skip the affected race.
async function handleLogin(page, context) {
  try {
    await ensureLoggedIn(page, context, {
      email: FG_EMAIL,
      password: FG_PASSWORD,
      targetUrl: page.url(),
    });
    return true;
  } catch (err) {
    console.error('❌ Mid-run re-login failed (race skipped): ' + err.message);
    return false;
  }
}

async function getPostTime(page, context, raceUrl, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(raceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);

      // If the target redirected us to auth, log in once and re-fetch.
      const loggedIn = await handleLogin(page, context);
      if (!loggedIn) {
        console.error('  ❌ Could not authenticate with France Galop');
        return null;
      }

      const currentUrl = page.url();
      if (!currentUrl.includes('/course/detail')) {
        await page.goto(raceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
      }

      const bodyText = await page.locator('body').innerText();

      // Match patterns like "15h58", "15:58", "Départ : 15h58"
      const timeMatch = bodyText.match(/(?:Départ|Depart|Post|Heure)?\s*:?\s*(\d{1,2})[h:](\d{2})/i);

      if (timeMatch) {
        const hour = parseInt(timeMatch[1]);
        const minute = parseInt(timeMatch[2]);
        return { hour, minute, formatted: `${hour}h${minute.toString().padStart(2, '0')}` };
      }

      return null;
    } catch (err) {
      console.error(`  ⚠️ Attempt ${attempt}/${retries} failed for ${raceUrl}: ${err.message}`);

      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  console.error(`  ❌ All ${retries} attempts failed for ${raceUrl}`);
  return null;
}

async function updateRaceData() {
  const parisTime = getParisTime();

  // Get DP-P races from engagements scraper's data
  const dppRaces = await loadDPPRaces();

  if (!dppRaces) {
    console.log('⚠️  Could not load DPP races data, keeping previous data');
    return false;
  }

  if (dppRaces.length === 0) {
    console.log('ℹ️  No DP-P horses found');
    await saveStoredRaces({ lastUpdate: parisTime.timestamp, races: [] });
    return true;
  }

  // Load existing stored races to preserve already-fetched post times
  const existingStored = await loadStoredRaces();
  const existingByUrl = new Map();
  for (const race of (existingStored.races || [])) {
    if (race.raceUrl && race.postTime) {
      existingByUrl.set(race.raceUrl, race);
    }
  }

  // Split into races that already have post times vs need fetching
  const alreadyHaveTimes = [];
  const needFetching = [];

  for (const race of dppRaces) {
    if (!race.raceUrl) {
      console.log(`  ⚠️  ${race.horse}: No race URL available`);
      continue;
    }
    const existing = existingByUrl.get(race.raceUrl);
    if (existing && existing.postTime) {
      // Keep existing post time, but merge latest horse/race data
      alreadyHaveTimes.push({ ...race, postTime: existing.postTime });
      console.log(`  ✓ ${race.horse}: ${existing.postTime.formatted} (cached)`);
    } else {
      needFetching.push(race);
    }
  }

  console.log(`📋 ${alreadyHaveTimes.length} races cached, ${needFetching.length} need fetching`);

  // Only launch browser if there are races to fetch
  const newlyFetched = [];
  if (needFetching.length > 0) {
    const browser = await chromium.launch({ headless: true });
    const storageState = await loadSessionStorageState();
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      storageState,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);

    // Proactive login before the fetch loop. If this fails we don't want to
    // spam one Discord alert per race URL — bail loudly once instead.
    try {
      await page.goto('https://www.france-galop.com/fr/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await ensureLoggedIn(page, ctx, {
        email: FG_EMAIL,
        password: FG_PASSWORD,
        targetUrl: 'https://www.france-galop.com/fr',
      });
    } catch (err) {
      console.error('❌ France Galop login failed: ' + err.message);
      await sendLoginFailureAlert('scrape_race_alerts', err.message, WEBHOOK);
      await browser.close();
      process.exit(1);
    }

    try {
      for (const race of needFetching) {
        console.log(`  Fetching post time for ${race.horse}...`);
        const postTime = await getPostTime(page, ctx, race.raceUrl);

        if (postTime) {
          newlyFetched.push({ ...race, postTime });
          console.log(`  ✓ ${race.horse}: ${postTime.formatted}`);
        } else {
          console.log(`  ✗ ${race.horse}: Could not get post time`);
        }
      }
    } finally {
      await browser.close();
    }
  }

  // Combine cached + newly fetched
  const allRaces = [...alreadyHaveTimes, ...newlyFetched];

  // Filter out past races
  const futureRaces = filterPastRaces(allRaces, parisTime);

  // Save to file
  await saveStoredRaces({
    lastUpdate: parisTime.timestamp,
    races: futureRaces,
  });

  console.log(`✅ Updated race data: ${futureRaces.length} future races stored (${newlyFetched.length} newly fetched)`);
  return true;
}

async function checkAndSendAlerts() {
  console.log('⏰ ALERT MODE: Checking for races to alert...');
  
  const parisTime = getParisTime();
  const sentAlerts = await loadSentAlerts();
  const stored = await loadStoredRaces();
  
  if (!stored.races || stored.races.length === 0) {
    console.log('ℹ️  No stored races to check');
    return;
  }

  // Filter out past races
  const futureRaces = filterPastRaces(stored.races, parisTime);
  
  if (futureRaces.length < stored.races.length) {
    console.log(`🗑️  Filtered out ${stored.races.length - futureRaces.length} past races`);
  }

  const currentMinutes = parisTime.hour * 60 + parisTime.minute;
  const alertsSent = [];

  for (const race of futureRaces) {
    const alertKey = `${race.raceUrl}`;
    
    if (sentAlerts.has(alertKey)) {
      continue;
    }

    // CRITICAL: Only alert for races happening TODAY
    // Compare date strings directly to avoid timezone issues
    const raceDateMatch = race.date.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!raceDateMatch) {
      console.log(`  ⚠️  ${race.horse}: Invalid date format "${race.date}", skipping`);
      continue;
    }
    
    const [, raceDay, raceMonth, raceYear] = raceDateMatch;
    const todayParts = parisTime.date.split('-'); // "2025-10-31" -> ["2025", "10", "31"]
    const [todayYear, todayMonth, todayDay] = todayParts;
    
    // Compare: year, month, day (all as strings with zero padding)
    if (raceYear !== todayYear || raceMonth !== todayMonth || raceDay !== todayDay) {
      // Race is not today, skip it
      continue;
    }

    const postTime = race.postTime;
    const raceMinutes = postTime.hour * 60 + postTime.minute;

    // Calculate alert window (between ALERT_WINDOW_START and ALERT_WINDOW_END before race)
    const windowStartMinutes = raceMinutes - ALERT_WINDOW_START;
    const windowEndMinutes = raceMinutes - ALERT_WINDOW_END;

    // Check if we're in alert window
    if (currentMinutes >= windowStartMinutes && currentMinutes < windowEndMinutes) {
      const minutesUntilRace = raceMinutes - currentMinutes;
      
      console.log(`🚨 SENDING ALERT for ${race.horse} - Race at ${postTime.formatted} (${minutesUntilRace} min)`);

      // Format race name with category if available
      const raceDisplay = race.cat ? `${race.race} (${race.cat})` : race.race;
      
      // Format distance if available (e.g., "1.400" -> "1400m")
      const distDisplay = race.dist ? ` — ${race.dist.replace('.', '')}m` : '';
      
      const content = `🚨 **ALERTE COURSE**\n⏰ **Départ:** ${postTime.formatted}\n\n🐴 **${race.horse}**\n📍 **Hippodrome:** ${race.track}\n🏆 **Course:** ${raceDisplay}${distDisplay}\n🔗 [**Voir la course**](${race.raceUrl})`;

      try {
        const res = await fetch(WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        });

        if (res.ok) {
          sentAlerts.add(alertKey);
          alertsSent.push(race.horse);
          console.log(`  ✅ Alert sent successfully`);
        } else {
          console.error('  ❌ Discord webhook failed:', await res.text());
        }
      } catch (err) {
        console.error('  ❌ Error sending alert:', err.message);
      }
    }
  }

  await saveSentAlerts(sentAlerts);

  if (alertsSent.length > 0) {
    console.log(`✅ Sent ${alertsSent.length} race alerts`);
  } else {
    console.log('ℹ️  No alerts to send at this time');
  }
}

(async () => {
  const parisTime = getParisTime();
  console.log(`\n⏰ Current Paris time: ${parisTime.formatted} on ${parisTime.date}\n`);
  
  const shouldUpdate = await shouldUpdateRaceData();
  
  if (shouldUpdate) {
    // UPDATE MODE: dpp_races.json was recently updated by engagements scraper
    console.log('🔄 UPDATE MODE: Engagements data is fresh - fetching post times\n');
    await updateRaceData();
    
    // Also check for alerts immediately after updating
    console.log('\n⏰ Now checking for alerts...\n');
    await checkAndSendAlerts();
  } else {
    // ALERT MODE: Just check stored races and send alerts
    console.log('⏰ ALERT MODE: Using stored race data\n');
    await checkAndSendAlerts();
  }
  
  console.log('\n✅ Run complete\n');
})();
