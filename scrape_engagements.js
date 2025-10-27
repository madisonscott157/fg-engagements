// Node 18+ / 20+; CommonJS. ENV: TRAINER_URL, DISCORD_WEBHOOK_URL

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// --- Run only at 10:35 or 12:35 in Paris (DST-safe) ---
const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).formatToParts(new Date());
const hh = parts.find(p => p.type === 'hour').value;
const mm = parts.find(p => p.type === 'minute').value;
const isRunTime = (hh === '10' && mm === '35') || (hh === '12' && mm === '35');
if (!isRunTime) {
  console.log(`Skipping run at Paris ${hh}:${mm}`);
  process.exit(0);
}
// -------------------------------------------------------

const TRAINER_URL = process.env.TRAINER_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

if (!TRAINER_URL || !WEBHOOK) {
  console.error('Missing TRAINER_URL or DISCORD_WEBHOOK_URL');
  process.exit(1);
}

const STORE_DIR = 'data';
const STORE_FILE = path.join(STORE_DIR, 'seen.json');

const norm = (s) =>
  (s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[’]/g, "'")
    .trim();

const keyify = (obj) =>
  norm([obj.horse, obj.date, obj.track, obj.race, obj.dist].join(' | ')).toLowerCase();

async function loadSeen() {
  try {
    const txt = await fs.readFile(STORE_FILE, 'utf8');
    return new Map(JSON.parse(txt)); // [[rowKey, {statut, last}]]
  } catch {
    await fs.mkdir(STORE_DIR, { recursive: true });
    return new Map();
  }
}

async function saveSeen(map) {
  const arr = Array.from(map.entries());
  const trimmed = arr.slice(-3000); // keep it small
  await fs.writeFile(STORE_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  await page.goto(TRAINER_URL, { waitUntil: 'domcontentloaded' });

  // Accept cookies if shown (FR/EN variants)
  for (const sel of [
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter tout")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
  ]) {
    const b = page.locator(sel);
    if (await b.count()) { await b.first().click().catch(()=>{}); break; }
  }

  // Click "Engagements" tab if present
  const tab = page.locator('text=Engagements');
  if (await tab.count()) await tab.first().click().catch(()=>{});

  await page.waitForTimeout(1500);

  // Find the Engagements table (header with Cheval + Statut)
  const allTables = page.locator('table');
  let table = null;
  for (let i = 0; i < await allTables.count(); i++) {
    const t = allTables.nth(i);
    const header = norm(await t.locator('thead, tr').first().innerText().catch(()=>'')); 
    if (/Cheval/i.test(header) && /Statut/i.test(header)) { table = t; break; }
  }
  if (!table) {
    const sec = page.locator('section:has-text("Engagements")');
    if (await sec.count()) {
      const t = sec.locator('table').first();
      if (await t.count()) table = t;
    }
  }
  if (!table) {
    console.log('No Engagements table found.');
    await browser.close();
    return [];
  }

  // Map header indices
  const headerCells = await table.locator('thead tr th, tr:first-child th, tr:first-child td').allInnerTexts();
  const headers = headerCells.map(norm);
  const idx = {
    horse: headers.findIndex(h => /^Cheval/i.test(h)),
    statut: headers.findIndex(h => /^Statut/i.test(h)),
    date:  headers.findIndex(h => /^Date/i.test(h)),
    track: headers.findIndex(h => /^Hippodrome/i.test(h)),
    race:  headers.findIndex(h => /^Prix/i.test(h)),
    cat:   headers.findIndex(h => /^Cat/i.test(h)),
    purse: headers.findIndex(h => /^Allocation/i.test(h)),
    disc:  headers.findIndex(h => /^Discipline/i.test(h)),
    dist:  headers.findIndex(h => /^Dist/i.test(h)),
    owner: headers.findIndex(h => /^Propri/i.test(h)),
  };
  const cell = (tds, i) => (i >= 0 && i < tds.length ? norm(tds[i]) : '');

  // Read rows
  const rows = table.locator('tbody tr');
  const out = [];
  for (let r = 0; r < await rows.count(); r++) {
    const tds = await rows.nth(r).locator('td').allInnerTexts();
    if (!tds.length) continue;
    const rec = {
      horse: cell(tds, idx.horse),
      statut: cell(tds, idx.statut),
      date: cell(tds, idx.date),
      track: cell(tds, idx.track),
      race: cell(tds, idx.race),
      cat: cell(tds, idx.cat),
      purse: cell(tds, idx.purse),
      disc: cell(tds, idx.disc),
      dist: cell(tds, idx.dist),
      owner: cell(tds, idx.owner),
    };
    if (rec.horse && rec.date && (rec.race || rec.track)) out.push(rec);
  }

  await browser.close();
  return out;
}

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
  const rows = await scrape();

  // In-run de-dupe by row key
  const runSeen = new Set();
  const unique = [];
  for (const r of rows) {
    const k = keyify(r);
    if (!runSeen.has(k)) { runSeen.add(k); unique.push(r); }
  }

  // Classify: brand-new vs statut-changed vs unchanged
  const newRows = [];
  const changedRows = [];

  for (const r of unique) {
    const k = keyify(r);
    const prev = seen.get(k);
    if (!prev) {
      newRows.push(r);
      seen.set(k, { statut: r.statut, last: Date.now() });
    } else if (prev.statut !== r.statut) {
      changedRows.push({ ...r, oldStatut: prev.statut });
      seen.set(k, { statut: r.statut, last: Date.now() });
    } else {
      // unchanged
      seen.set(k, { statut: prev.statut, last: Date.now() });
    }
  }

  if (newRows.length === 0 && changedRows.length === 0) {
    console.log('No new/changed engagements — nothing to post.');
    await saveSeen(seen);
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  const linesNew = newRows.map(
    r => `• ${r.horse} — ${r.date} — ${r.track} — ${r.race} (${r.cat || '-'}) — ${r.dist || '-'} — Statut: ${r.statut}`
  );
  const linesUpd = changedRows.map(
    r => `• ${r.horse} — ${r.date} — ${r.track} — ${r.race} (${r.cat || '-'}) — ${r.dist || '-'} — Statut: ${r.oldStatut} → ${r.statut}`
  );

  const payloads = [];
  if (linesNew.length) {
    payloads.push(...chunkLines(`🆕 **Nouvelles engagements — ${today}**`, linesNew));
  }
  if (linesUpd.length) {
    payloads.push(...chunkLines(`🔄 **Statut mis à jour — ${today}**`, linesUpd));
  }

  for (const content of payloads) {
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

  await saveSeen(seen);
})();
