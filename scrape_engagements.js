// Node 18+ / 20+; CommonJS.
// ENV required: TRAINER_URL, DISCORD_WEBHOOK_URL
// Behavior: posts only NEW rows or rows whose Statut changed, twice daily (10:35 & 12:35 Paris).
// Embeds: horse name (embed title) is a clickable link; "Prix" field is a clickable link when available.

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// ---- Time gate: run only at 10:35 or 12:35 Europe/Paris (DST-safe).
// Set FORCE_RUN=1 in the workflow env to bypass this for testing (no code edits needed).
const FORCE_RUN = process.env.FORCE_RUN === '1';
if (!FORCE_RUN) {
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
} else {
  console.log('FORCE_RUN=1 → bypassing time gate for test run');
}

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
  const trimmed = arr.slice(-3000); // keep small
  await fs.writeFile(STORE_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function absolutize(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return 'https://www.france-galop.com' + url;
  return url;
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  await page.goto(TRAINER_URL, { waitUntil: 'domcontentloaded' });

  // Accept cookie banner (FR/EN variants)
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

  // Wait precisely for the table to exist (up to 15s)
  await Promise.race([
    page.locator('section:has-text("Engagements") table').first().waitFor({ timeout: 15000 }),
    page.locator('table:has-text("Cheval")').first().waitFor({ timeout: 15000 }),
  ]).catch(() => {});

  // Find the Engagements table (look for headers "Cheval" and "Statut")
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

  // Map column indices
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

  // Extract rows
  const rows = table.locator('tbody tr');
  const out = [];
  for (let r = 0; r < await rows.count(); r++) {
    const row = rows.nth(r);
    const tds = await row.locator('td').allInnerTexts();
    if (!tds.length) continue;

    // Links from Cheval & Prix cells
    let horseUrl = '';
    let raceUrl = '';
    try {
      if (idx.horse >= 0) {
        const a = row.locator('td').nth(idx.horse).locator('a').first();
        if (await a.count()) horseUrl = absolutize(await a.getAttribute('href'));
      }
      if (idx.race >= 0) {
        const a2 = row.locator('td').nth(idx.race).locator('a').first();
        if (await a2.count()) raceUrl = absolutize(await a2.getAttribute('href'));
      }
    } catch {}

    const rec = {
      horse: cell(tds, idx.horse),
      statut: cell(tds, idx.statut),
      date:   cell(tds, idx.date),
      track:  cell(tds, idx.track),
      race:   cell(tds, idx.race),
      cat:    cell(tds, idx.cat),
      purse:  cell(tds, idx.purse),
      disc:   cell(tds, idx.disc),
      dist:   cell(tds, idx.dist),
      owner:  cell(tds, idx.owner),
      horseUrl,
      raceUrl,
    };

    if (rec.horse && rec.date && (rec.race || rec.track)) out.push(rec);
  }

  await browser.close();
  return out;
}

// ---------- Embed posting (clickable horse title & Prix link) ----------
function mdLink(text, url) {
  const t = text || '-';
  if (!url) return t;
  // Masked links are supported in embed fields
  return `[${t}](${url})`;
}

function chunkEmbeds(arr, size = 10) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function postEmbeds(title, embeds, today) {
  if (!embeds.length) return;
  const chunks = chunkEmbeds(embeds, 10);
  for (const chunk of chunks) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `${title} — ${today}`,
        embeds: chunk,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      console.error('Discord webhook failed', await res.text());
      process.exit(2);
    }
  }
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

  // Classify: new vs statut-changed vs unchanged
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
      seen.set(k, { statut: prev.statut, last: Date.now() });
    }
  }

  if (newRows.length === 0 && changedRows.length === 0) {
    console.log('No new/changed engagements — nothing to post.');
    await saveSeen(seen);
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  const COLOR_NEW = 0x2b6cb0;  // blue
  const COLOR_UPD = 0xf59e0b;  // amber

  const toEmbed = (r, type) => {
    const prixField = mdLink(r.race || '-', r.raceUrl || '');
    const fields = [
      { name: 'Date',       value: r.date || '-',  inline: true },
      { name: 'Hippodrome', value: r.track || '-', inline: true },
      { name: 'Prix',       value: prixField,      inline: true }, // hyperlink here
      { name: 'Cat.',       value: r.cat  || '-',  inline: true },
      { name: 'Dist.',      value: r.dist || '-',  inline: true },
    ];
    if (type === 'new') {
      fields.push({ name: 'Statut', value: r.statut || '-', inline: true });
    } else {
      fields.push({ name: 'Statut', value: `${r.oldStatut || '-'} → ${r.statut || '-'}`, inline: true });
    }
    return {
      title: r.horse || 'Cheval',
      url: r.horseUrl || undefined, // clickable horse title
      color: type === 'new' ? COLOR_NEW : COLOR_UPD,
      fields,
      timestamp: new Date().toISOString(),
    };
  };

  const embedsNew = newRows.map(r => toEmbed(r, 'new'));
  const embedsUpd = changedRows.map(r => toEmbed(r, 'upd'));

  await postEmbeds('🆕 **Nouvelles engagements**', embedsNew, today);
  await postEmbeds('🔄 **Statut mis à jour**', embedsUpd, today);

  await saveSeen(seen);
})();
