// Node 18+ / 20+; CommonJS. ENV: DISCORD_WEBHOOK_RACE_ALERTS

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

const WEBHOOK = process.env.DISCORD_WEBHOOK_RACE_ALERTS;

if (!WEBHOOK) {
  console.error('Missing DISCORD_WEBHOOK_RACE_ALERTS');
  process.exit(1);
}

const STORE_DIR = 'data';
const ALERTS_FILE = path.join(STORE_DIR, 'sent_alerts.json');
const RACES_FILE = path.join(STORE_DIR, 'stored_races.json');
const DPP_FILE = path.join(STORE_DIR, 'dpp_races.json');

// Update windows: 10:40-10:50 AM and 12:40-12:50 PM (after engagements runs)
const UPDATE_WINDOWS = [
  { startHour: 10, startMin: 40, endHour: 10, endMin: 50 },
  { startHour: 12, startMin: 40, endHour: 12, endMin: 50 },
];

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
    formatted: `${parts.hour}:${parts.minute}`,
    timestamp: now.toISOString(),
  };
}

function isInUpdateWindow(parisTime) {
  const currentMinutes = parisTime.hour * 60 + parisTime.minute;
  
  for (const window of UPDATE_WINDOWS) {
    const startMinutes = window.startHour * 60 + window.startMin;
    const endMinutes = window.endHour * 60 + window.endMin;
    
    if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) {
      return true;
    }
  }
  
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

async function getPostTime(raceUrl) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto(raceUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const bodyText = await page.locator('body').innerText();
    
    // Match patterns like "15h58", "15:58", "Départ : 15h58"
    const timeMatch = bodyText.match(/(?:Départ|Post|Heure)?\s*:?\s*(\d{1,2})[h:](\d{2})/i);
    
    if (timeMatch) {
      const hour = parseInt(timeMatch[1]);
      const minute = parseInt(timeMatch[2]);
      await browser.close();
      return { hour, minute, formatted: `${hour}h${minute.toString().padStart(2, '0')}` };
    }

    await browser.close();
    return null;
  } catch (err) {
    console.error(`❌ Error fetching post time from ${raceUrl}:`, err.message);
    await browser.close();
    return null;
  }
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

  // Get post time for each race (only scraping we do!)
  const racesWithTimes = [];
  for (const race of dppRaces) {
    // Skip if no race URL
    if (!race.raceUrl) {
      console.log(`  ⚠️  ${race.horse}: No race URL available`);
      continue;
    }
    
    console.log(`  Fetching post time for ${race.horse}...`);
    const postTime = await getPostTime(race.raceUrl);
    
    if (postTime) {
      racesWithTimes.push({
        ...race,
        postTime,
      });
      console.log(`  ✓ ${race.horse}: ${postTime.formatted}`);
    } else {
      console.log(`  ✗ ${race.horse}: Could not get post time`);
    }
  }

  // Filter out past races
  const futureRaces = filterPastRaces(racesWithTimes, parisTime);
  
  // Save to file
  await saveStoredRaces({
    lastUpdate: parisTime.timestamp,
    races: futureRaces,
  });

  console.log(`✅ Updated race data: ${futureRaces.length} future races stored`);
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

    const postTime = race.postTime;
    
    // Calculate alert time (10 min before)
    const alertHour = postTime.hour;
    let alertMinute = postTime.minute - 10;
    let alertHourAdjusted = alertHour;
    if (alertMinute < 0) {
      alertMinute += 60;
      alertHourAdjusted -= 1;
    }

    const alertMinutes = alertHourAdjusted * 60 + alertMinute;
    const raceMinutes = postTime.hour * 60 + postTime.minute;

    // Check if we're in alert window
    if (currentMinutes >= alertMinutes && currentMinutes < raceMinutes) {
      const minutesUntilRace = raceMinutes - currentMinutes;
      
      console.log(`🚨 SENDING ALERT for ${race.horse} - Race at ${postTime.formatted} (${minutesUntilRace} min)`);

      const content = `🚨 **ALERTE COURSE**\n⏰ **Départ:** ${postTime.formatted}\n\n🐇 **${race.horse}**\n📍 **Hippodrome:** ${race.track}\n🏆 **Course:** ${race.race}\n🔗 [**Voir la course**](${race.raceUrl})`;

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
  console.log(`\n⏰ Current Paris time: ${parisTime.formatted} on ${parisTime.date}`);
  
  const inUpdateWindow = isInUpdateWindow(parisTime);
  
  if (inUpdateWindow) {
    // UPDATE MODE: Read DPP data and fetch post times
    console.log('📍 In update window - will fetch post times from France Galop\n');
    await updateRaceData();
  } else {
    // ALERT MODE: Just check stored races and send alerts
    console.log('📍 Not in update window - using stored data\n');
    await checkAndSendAlerts();
  }
  
  console.log('\n✅ Run complete\n');
})();
