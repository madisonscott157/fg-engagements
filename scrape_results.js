// Node 18+ / 20+; CommonJS. ENV: RESULTS_URL, DISCORD_WEBHOOK_RESULTS

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

const RESULTS_URL = process.env.RESULTS_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_RESULTS;
const MANUAL_RUN = process.env.MANUAL_RUN === 'true';
const FORCE_POST = process.env.FORCE_POST === 'true';

if (!RESULTS_URL || !WEBHOOK) {
  console.error('Missing RESULTS_URL or DISCORD_WEBHOOK_RESULTS');
  process.exit(1);
}

if (MANUAL_RUN) {
  console.log('🔧 MANUAL RUN - bypassing schedule checks');
}

if (FORCE_POST) {
  console.log('🔧 FORCE POST - will post all current results for testing');
}

const STORE_DIR = 'data';
const RESULTS_FILE = path.join(STORE_DIR, 'seen_results.json');
const PENDING_FILE = path.join(STORE_DIR, 'pending_tracking.json');

const norm = (s) =>
  (s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[']/g, "'")
    .trim();

const keyify = (obj) =>
  norm([obj.horse, obj.date, obj.hippodrome, obj.distance].join(' | ')).toLowerCase();

async function loadSeen() {
  try {
    const txt = await fs.readFile(RESULTS_FILE, 'utf8');
    return new Map(JSON.parse(txt));
  } catch {
    await fs.mkdir(STORE_DIR, { recursive: true });
    return new Map();
  }
}

async function saveSeen(map) {
  const arr = Array.from(map.entries());
  const trimmed = arr.slice(-2000);
  await fs.writeFile(RESULTS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

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

async function scrapeResults() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  await page.goto(RESULTS_URL, { waitUntil: 'domcontentloaded' });

  // Accept cookies
  for (const sel of [
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter tout")',
    'button:has-text("Accept all")',
  ]) {
    const b = page.locator(sel);
    if (await b.count()) { await b.first().click().catch(()=>{}); break; }
  }

  await page.waitForTimeout(1500);

  // Find "Dernières courses" table
  const allTables = page.locator('table');
  const tableCount = await allTables.count();
  console.log(`Found ${tableCount} tables, searching for Dernières courses...`);

  let table = null;
  for (let i = 0; i < tableCount; i++) {
    const t = allTables.nth(i);
    const header = norm(await t.locator('thead, tr').first().innerText().catch(() => ''));
    if (/Date/i.test(header) && /Place/i.test(header) && /Cheval/i.test(header)) {
      console.log(`✓ Found results table at index ${i}`);
      table = t;
      break;
    }
  }

  if (!table) {
    console.log('No results table found');
    await browser.close();
    return [];
  }

  // Map headers
  const headerCells = await table.locator('thead tr th, tr:first-child th, tr:first-child td').allInnerTexts();
  const headers = headerCells.map(norm);
  const idx = {
    date: headers.findIndex(h => /^Date/i.test(h)),
    place: headers.findIndex(h => /^Place/i.test(h)),
    horse: headers.findIndex(h => /^Cheval/i.test(h)),
    distance: headers.findIndex(h => /^Distance/i.test(h)),
    cat: headers.findIndex(h => /^Cat/i.test(h)),
    disc: headers.findIndex(h => /^Disc/i.test(h)),
    poids: headers.findIndex(h => /^Poids/i.test(h)),
    hippodrome: headers.findIndex(h => /^Hippodrome/i.test(h)),
    owner: headers.findIndex(h => /^Propri/i.test(h)),
    jockey: headers.findIndex(h => /^Jockey/i.test(h)),
    gain: headers.findIndex(h => /^Gain/i.test(h)),
  };

  const cell = (tds, i) => (i >= 0 && i < tds.length ? norm(tds[i]) : '');

  // Read rows
  const rows = table.locator('tbody tr, tr').filter({ hasNot: page.locator('th') });
  const out = [];
  
  for (let r = 0; r < await rows.count(); r++) {
    const row = rows.nth(r);
    const tds = await row.locator('td').allInnerTexts();
    if (!tds.length) continue;

    // Extract horse URL
    let horseUrl = '';
    if (idx.horse >= 0) {
      const horseLink = row.locator('td').nth(idx.horse).locator('a').first();
      if (await horseLink.count()) {
        const href = await horseLink.getAttribute('href');
        if (href) {
          horseUrl = href.startsWith('http') ? href : `https://www.france-galop.com${href}`;
        }
      }
    }

    // Extract date/race URL
    let raceUrl = '';
    if (idx.date >= 0) {
      const dateLink = row.locator('td').nth(idx.date).locator('a').first();
      if (await dateLink.count()) {
        const href = await dateLink.getAttribute('href');
        if (href) {
          raceUrl = href.startsWith('http') ? href : `https://www.france-galop.com${href}`;
        }
      }
    }

    const rec = {
      date: cell(tds, idx.date),
      place: cell(tds, idx.place),
      horse: cell(tds, idx.horse),
      horseUrl: horseUrl,
      distance: cell(tds, idx.distance),
      cat: cell(tds, idx.cat),
      disc: cell(tds, idx.disc),
      poids: cell(tds, idx.poids),
      hippodrome: cell(tds, idx.hippodrome),
      owner: cell(tds, idx.owner),
      jockey: cell(tds, idx.jockey),
      gain: cell(tds, idx.gain),
      raceUrl: raceUrl,
    };

    if (rec.horse && rec.date) out.push(rec);
  }

  console.log(`Scraped ${out.length} results`);
  await browser.close();
  return out;
}

const formatLink = (text, url) => {
  if (url && url.startsWith('http')) {
    return `[${text}](${url})`;
  }
  return text;
};

function chunkLines(header, lines, maxLen = 1800) {
  const chunks = [];
  let buf = [];
  let len = header.length + 1;
  for (const ln of lines) {
    if (len + ln.length + 1 > maxLen) {
      chunks.push(`${header}\n${buf.join('\n')}`);
      buf = [ln];
      len = header.length + 1 + ln.length + 1;
    } else {
      buf.push(ln);
      len += ln.length + 1;
    }
  }
  if (buf.length) chunks.push(`${header}\n${buf.join('\n')}`);
  return chunks;
}

(async () => {
  const seen = await loadSeen();
  const results = await scrapeResults();

  // Find new results
  const newResults = [];
  for (const r of results) {
    const k = keyify(r);
    if (FORCE_POST || !seen.has(k)) {
      newResults.push(r);
      seen.set(k, { date: r.date, timestamp: Date.now() });
    }
  }

  if (newResults.length === 0) {
    console.log('No new results - nothing to post');
    await saveSeen(seen);
    process.exit(0);
  }

  // Load pending tracking list
  const pending = await loadPendingTracking();

  // Post new results and add to tracking queue
  const today = new Date().toISOString().slice(0, 10);
  const lines = newResults.map(
    r => `• ${formatLink(r.horse, r.horseUrl)} - Place: ${r.place} - ${r.distance} - ${r.cat || '-'} - ${r.hippodrome} - ${formatLink(r.date, r.raceUrl)}`
  );

  const chunks = chunkLines(`🏁 **NOUVEAUX RÉSULTATS — ${today}**`, lines);

  for (const content of chunks) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });

    if (!res.ok) {
      console.error('Discord webhook failed', await res.text());
      process.exit(2);
    }
  }

  // Add new results to pending tracking queue
  for (const r of newResults) {
    if (r.raceUrl) {
      pending.push({
        horse: r.horse,
        date: r.date,
        raceUrl: r.raceUrl,
        hippodrome: r.hippodrome,
        addedAt: Date.now(),
      });
    }
  }

  await saveSeen(seen);
  await savePendingTracking(pending);

  console.log(`✅ Posted ${newResults.length} new results, ${pending.length} races queued for tracking check`);
})();
