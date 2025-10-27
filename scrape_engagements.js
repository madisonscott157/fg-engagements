// Node 18+ / 20+; CommonJS. ENV: TRAINER_URL, DISCORD_WEBHOOK_URL, MANUAL_RUN (optional)

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

const TRAINER_URL = process.env.TRAINER_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const MANUAL_RUN = process.env.MANUAL_RUN === 'true';
const FORCE_POST = process.env.FORCE_POST === 'true';

if (!TRAINER_URL || !WEBHOOK) {
  console.error('Missing TRAINER_URL or DISCORD_WEBHOOK_URL');
  process.exit(1);
}

if (MANUAL_RUN) {
  console.log('🔧 MANUAL RUN - bypassing schedule checks');
}

if (FORCE_POST) {
  console.log('🔧 FORCE POST - will post all current engagements for testing');
}

const STORE_DIR = 'data';
const STORE_FILE = path.join(STORE_DIR, 'seen.json');

const norm = (s) =>
  (s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[']/g, "'")
    .trim();

const keyify = (obj) =>
  norm([obj.horse, obj.date, obj.track, obj.race, obj.dist].join(' | ')).toLowerCase();

// Format name with optional hyperlink for Discord
const formatLink = (text, url) => {
  if (url && url.startsWith('http')) {
    return `[${text}](${url})`;
  }
  return text;
};

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

  // Click "Plus" button repeatedly to load all engagements
  let clickedPlus = false;
  let previousRowCount = 0;
  
  for (let i = 0; i < 20; i++) { // max 20 clicks to avoid infinite loop
    // Count current rows before clicking
    const currentRowCount = await page.locator('table tbody tr').count();
    
    // If row count didn't change from last click, stop (no more data to load)
    if (i > 0 && currentRowCount === previousRowCount) {
      console.log(`Row count unchanged (${currentRowCount} rows) - stopping`);
      break;
    }
    
    previousRowCount = currentRowCount;
    
    const plusButton = page.locator('button:has-text("Plus"), button:has-text("plus"), a:has-text("Plus"), a:has-text("plus")');
    const count = await plusButton.count();
    
    if (count > 0 && await plusButton.first().isVisible().catch(() => false)) {
      console.log(`Clicking "Plus" button (attempt ${i + 1}, currently ${currentRowCount} rows)...`);
      await plusButton.first().click().catch(() => {});
      clickedPlus = true;
      await page.waitForTimeout(2000); // wait 2 seconds for new rows to load
    } else {
      if (clickedPlus) {
        console.log(`No more "Plus" button - all engagements loaded (${currentRowCount} rows)`);
      }
      break;
    }
  }

  // Extra wait to ensure all content is fully rendered
  if (clickedPlus) {
    await page.waitForTimeout(2000);
    console.log('Waiting for all content to fully render...');
  }

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
  let skippedCount = 0;
  
  for (let r = 0; r < await rows.count(); r++) {
    const row = rows.nth(r);
    const tds = await row.locator('td').allInnerTexts();
    if (!tds.length) {
      skippedCount++;
      continue;
    }
    
    // Extract links for horse name and race name
    let horseUrl = '';
    let raceUrl = '';
    
    if (idx.horse >= 0) {
      const horseLink = row.locator('td').nth(idx.horse).locator('a').first();
      if (await horseLink.count()) {
        const href = await horseLink.getAttribute('href');
        if (href) {
          horseUrl = href.startsWith('http') ? href : `https://www.france-galop.com${href}`;
        }
      }
    }
    
    if (idx.race >= 0) {
      const raceLink = row.locator('td').nth(idx.race).locator('a').first();
      if (await raceLink.count()) {
        const href = await raceLink.getAttribute('href');
        if (href) {
          raceUrl = href.startsWith('http') ? href : `https://www.france-galop.com${href}`;
        }
      }
    }
    
    const rec = {
      horse: cell(tds, idx.horse),
      horseUrl: horseUrl,
      statut: cell(tds, idx.statut),
      date: cell(tds, idx.date),
      track: cell(tds, idx.track),
      race: cell(tds, idx.race),
      raceUrl: raceUrl,
      cat: cell(tds, idx.cat),
      purse: cell(tds, idx.purse),
      disc: cell(tds, idx.disc),
      dist: cell(tds, idx.dist),
      owner: cell(tds, idx.owner),
    };
    
    if (rec.horse && rec.date && (rec.race || rec.track)) {
      out.push(rec);
    } else {
      skippedCount++;
    }
  }
  
  console.log(`Scraped ${out.length} valid engagements (skipped ${skippedCount} invalid/empty rows)`);

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
    
    // If FORCE_POST, treat everything as new for display purposes
    if (FORCE_POST) {
      newRows.push(r);
      seen.set(k, { statut: r.statut, last: Date.now() });
    } else if (!prev) {
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

  // Find all DP-P (declared participants) from unique rows
  // Match DP-P even if followed by /number or other suffixes
  const declaredParticipants = unique.filter(r => /^DP-P/i.test(r.statut));
  
  if (newRows.length === 0 && changedRows.length === 0 && declaredParticipants.length === 0) {
    console.log('No new/changed engagements and no declared participants — nothing to post.');
    await saveSeen(seen);
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  
  // Format DP-P horses (running next)
  const linesDPP = declaredParticipants.map(
    r => `• ${formatLink(r.horse, r.horseUrl)} — ${r.date} — ${r.track} — ${formatLink(r.race, r.raceUrl)} (${r.cat || '-'}) — ${r.dist || '-'}`
  );
  
  // Format new engagements
  const linesNew = newRows.map(
    r => `• ${formatLink(r.horse, r.horseUrl)} — ${r.date} — ${r.track} — ${formatLink(r.race, r.raceUrl)} (${r.cat || '-'}) — ${r.dist || '-'} — Statut: ${r.statut}`
  );
  
  // Format status updates
  const linesUpd = changedRows.map(
    r => `• ${formatLink(r.horse, r.horseUrl)} — ${r.date} — ${r.track} — ${formatLink(r.race, r.raceUrl)} (${r.cat || '-'}) — ${r.dist || '-'} — Statut: ${r.oldStatut} → ${r.statut}`
  );

  const payloads = [];
  
  // DP-P horses always go first
  if (linesDPP.length) {
    payloads.push(...chunkLines(`🏇 **PARTANTS — ${today}**`, linesDPP));
  }
  
  // Then new engagements
  if (linesNew.length) {
    payloads.push(...chunkLines(`🆕 **Nouvelles engagements — ${today}**`, linesNew));
  }
  
  // Then status updates
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
  console.log(`✅ Posted ${declaredParticipants.length} declared participants + ${newRows.length} new + ${changedRows.length} updated engagements`);
})();
