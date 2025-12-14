// Node 18+ / 20+; CommonJS. ENV: RESULTS_URL, DISCORD_WEBHOOK_RESULTS
// Google Sheets/Docs integration: GOOGLE_SERVICE_ACCOUNT, SPREADSHEET_ID, DOC_ID

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { google } = require('googleapis');

const RESULTS_URL = process.env.RESULTS_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_RESULTS;
const MANUAL_RUN = process.env.MANUAL_RUN === 'true';
const FORCE_POST = process.env.FORCE_POST === 'true';

// Google integration
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DOC_ID = process.env.DOC_ID;

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

// Clean horse name for Google Sheets: "BANKER NINE GB M.PS. 2 a." -> "Banker Nine"
const cleanHorseNameForSheet = (name) => {
  if (!name) return '';
  let cleaned = name
    .replace(/\s+(GB|IRE|FR|USA|AUS|GER|ITY|JPN|NZ|ARG|BRZ|CAN|CHI|DEN|HK|IND|KOR|MAC|MEX|NOR|PER|POL|POR|SAF|SIN|SPA|SWE|SWI|TUR|UAE|URU)\b.*/i, '')
    .replace(/\s*\([A-Z]{2,3}\).*$/i, '')
    .trim();
  
  cleaned = cleaned
    .toLowerCase()
    .split(' ')
    .map(word => {
      if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/i.test(word)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
  
  return cleaned;
};

// Clean horse name for Discord: remove PS. but keep country/sex/age
const cleanHorseNameForDiscord = (name) => {
  if (!name) return '';
  return name.replace(/\.PS\./g, '.').replace(/PS\./g, '').trim();
};

// Clean category: ((Classe 2)) -> (C2), ((Maiden)) -> (Maiden)
const cleanCategory = (cat) => {
  if (!cat) return '';
  let cleaned = cat;
  // Remove double parentheses - keep doing it until none left
  while (cleaned.includes('((') || cleaned.includes('))')) {
    cleaned = cleaned.replace(/\(\(/g, '(').replace(/\)\)/g, ')');
  }
  // Shorten Classe to C
  cleaned = cleaned.replace(/Classe\s*(\d)/gi, 'C$1');
  return cleaned;
};

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

// ============ GOOGLE SHEETS/DOCS INTEGRATION ============

async function getGoogleAuth() {
  if (!GOOGLE_SERVICE_ACCOUNT) {
    console.log('⚠️ No GOOGLE_SERVICE_ACCOUNT - skipping Google integration');
    return null;
  }
  
  try {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents'
      ]
    });
    return auth;
  } catch (err) {
    console.error('Failed to parse Google credentials:', err.message);
    return null;
  }
}

// Lookup owner from Sélection 2025/2026 tabs
async function lookupOwner(sheets, horseName) {
  const cleanedName = cleanHorseNameForSheet(horseName).toLowerCase();
  
  for (const tabName of ['Sélection 2026', 'Sélection 2025']) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${tabName}'!A:Z`,
      });
      
      const rows = response.data.values || [];
      if (rows.length === 0) continue;
      
      const headers = rows[0].map(h => (h || '').toString().trim());
      const nameCol = headers.findIndex(h => /^Name$/i.test(h));
      const ownerCol = headers.findIndex(h => /^Propriétaire$/i.test(h));
      
      if (nameCol === -1 || ownerCol === -1) continue;
      
      for (let i = 1; i < rows.length; i++) {
        const rowName = (rows[i][nameCol] || '').toString().trim().toLowerCase();
        if (rowName === cleanedName) {
          return (rows[i][ownerCol] || '').toString().trim();
        }
      }
    } catch (err) {
      console.log(`Could not read ${tabName}: ${err.message}`);
    }
  }
  
  return '';
}

// Write rows to "Mises à jour" tab - INSERT AT TOP (row 2) with black hyperlinks
async function writeToSheet(sheets, rowsToAdd) {
  if (!rowsToAdd.length) return;
  
  try {
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID
    });
    
    const misesSheet = spreadsheet.data.sheets.find(
      s => s.properties.title === 'Mises à jour'
    );
    
    if (!misesSheet) {
      console.error('Could not find "Mises à jour" tab');
      return;
    }
    
    const sheetId = misesSheet.properties.sheetId;
    
    // Insert empty rows at row 2
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: 1,
              endIndex: 1 + rowsToAdd.length
            },
            inheritFromBefore: false
          }
        }]
      }
    });
    
    // Write data to row 2
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Mises à jour'!A2:E${1 + rowsToAdd.length}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rowsToAdd
      }
    });
    
    // Set hyperlink column (D) to black text color
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: sheetId,
              startRowIndex: 1,
              endRowIndex: 1 + rowsToAdd.length,
              startColumnIndex: 3,
              endColumnIndex: 4
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  foregroundColor: {
                    red: 0,
                    green: 0,
                    blue: 0
                  }
                }
              }
            },
            fields: 'userEnteredFormat.textFormat.foregroundColor'
          }
        }]
      }
    });
    
    console.log(`📊 Added ${rowsToAdd.length} rows to Mises à jour (at top)`);
  } catch (err) {
    console.error('Failed to write to sheet:', err.message);
  }
}

// Write to Google Doc - INSERT AT TOP with bold formatting, uppercase owner, black hyperlinks
async function appendToDoc(docs, entries) {
  if (!entries || entries.length === 0) return;
  
  try {
    const doc = await docs.documents.get({ documentId: DOC_ID });
    
    let insertIndex = 1;
    if (doc.data.body.content.length > 1) {
      insertIndex = doc.data.body.content[1].startIndex || 1;
    }
    
    // Format date like "14 December 2025"
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                    'July', 'August', 'September', 'October', 'November', 'December'];
    const now = new Date();
    const docDate = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
    
    // Group entries by owner
    const byOwner = {};
    for (const entry of entries) {
      const ownerKey = entry.owner ? entry.owner.toUpperCase() : 'UNKNOWN OWNER';
      if (!byOwner[ownerKey]) byOwner[ownerKey] = [];
      byOwner[ownerKey].push(entry);
    }
    
    // Build text content
    const line1 = '\n═══════════════════════════════════════\n';
    const line2 = docDate + ' — France Galop Résultats\n';
    const line3 = '═══════════════════════════════════════\n';
    
    let ownerLines = '';
    const hyperlinkPositions = [];
    let currentPos = insertIndex + line1.length + line2.length + line3.length;
    
    for (const [ownerName, ownerEntries] of Object.entries(byOwner)) {
      ownerLines += ownerName + '\n';
      currentPos += ownerName.length + 1;
      
      for (let i = 0; i < ownerEntries.length; i++) {
        const entry = ownerEntries[i];
        const horseName = entry.horseName.toUpperCase();
        const horseLine = '   ' + horseName + '\n';
        ownerLines += horseLine;
        currentPos += horseLine.length;
        
        const detailPrefix = '      ';
        const linkText = entry.changeType;
        const detailSuffix = ': ' + entry.notes + '\n';
        
        ownerLines += detailPrefix + linkText + detailSuffix;
        
        // Track hyperlink position
        hyperlinkPositions.push({
          start: currentPos + detailPrefix.length,
          end: currentPos + detailPrefix.length + linkText.length,
          url: entry.raceUrl
        });
        
        currentPos += detailPrefix.length + linkText.length + detailSuffix.length;
        
        // Add blank line between horses (but not after the last one)
        if (i < ownerEntries.length - 1) {
          ownerLines += '\n';
          currentPos += 1;
        }
      }
      
      // Add blank line between owners
      ownerLines += '\n';
      currentPos += 1;
    }
    
    const fullContent = line1 + line2 + line3 + ownerLines;
    
    // Insert text
    await docs.documents.batchUpdate({
      documentId: DOC_ID,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: insertIndex },
            text: fullContent
          }
        }]
      }
    });
    
    // Calculate bold range
    const boldStart = insertIndex + line1.length;
    const boldEnd = insertIndex + line1.length + line2.length + line3.length;
    
    // Build formatting requests
    const formatRequests = [
      {
        updateTextStyle: {
          range: { startIndex: boldStart, endIndex: boldEnd },
          textStyle: { bold: true },
          fields: 'bold'
        }
      }
    ];
    
    // Add hyperlinks with black color
    for (const hp of hyperlinkPositions) {
      if (hp.url && hp.url.startsWith('http')) {
        formatRequests.push({
          updateTextStyle: {
            range: { startIndex: hp.start, endIndex: hp.end },
            textStyle: {
              link: { url: hp.url },
              foregroundColor: {
                color: {
                  rgbColor: { red: 0, green: 0, blue: 0 }
                }
              }
            },
            fields: 'link,foregroundColor'
          }
        });
      }
    }
    
    // Bold owner names and horse names
    let pos = insertIndex + line1.length + line2.length + line3.length;
    for (const [ownerName, ownerEntries] of Object.entries(byOwner)) {
      formatRequests.push({
        updateTextStyle: {
          range: { startIndex: pos, endIndex: pos + ownerName.length },
          textStyle: { bold: true },
          fields: 'bold'
        }
      });
      pos += ownerName.length + 1;
      
      for (let i = 0; i < ownerEntries.length; i++) {
        const entry = ownerEntries[i];
        const horseName = entry.horseName.toUpperCase();
        formatRequests.push({
          updateTextStyle: {
            range: { startIndex: pos + 3, endIndex: pos + 3 + horseName.length },
            textStyle: { bold: true },
            fields: 'bold'
          }
        });
        pos += 3 + horseName.length + 1;
        
        const detailLine = '      ' + entry.changeType + ': ' + entry.notes + '\n';
        pos += detailLine.length;
        
        // Account for blank line between horses
        if (i < ownerEntries.length - 1) {
          pos += 1;
        }
      }
      
      // Account for blank line between owners
      pos += 1;
    }
    
    // Apply formatting
    if (formatRequests.length > 0) {
      await docs.documents.batchUpdate({
        documentId: DOC_ID,
        requestBody: { requests: formatRequests }
      });
    }
    
    console.log(`📄 Added to Training Changes Log (at top)`);
  } catch (err) {
    console.error('Failed to write to doc:', err.message);
  }
}

// Format date as DD/MM/YYYY
const formatDate = (date) => {
  const d = date || new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

// Build hyperlink formula for Google Sheets
const sheetHyperlink = (text, url) => {
  if (url && url.startsWith('http')) {
    const safeText = text.replace(/"/g, '""');
    // Don't escape the URL - just wrap it properly
    return `=HYPERLINK("${url}","${safeText}")`;
  }
  return text;
};

// ============ SCRAPING ============

async function scrapeResults() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  await page.goto(RESULTS_URL, { waitUntil: 'domcontentloaded' });

  for (const sel of [
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter tout")',
    'button:has-text("Accept all")',
  ]) {
    const b = page.locator(sel);
    if (await b.count()) { await b.first().click().catch(()=>{}); break; }
  }

  await page.waitForTimeout(1500);

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

  const rows = table.locator('tbody tr, tr').filter({ hasNot: page.locator('th') });
  const out = [];
  
  for (let r = 0; r < await rows.count(); r++) {
    const row = rows.nth(r);
    const tds = await row.locator('td').allInnerTexts();
    if (!tds.length) continue;

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

  // ============ GOOGLE SHEETS/DOCS INTEGRATION ============
  
  const auth = await getGoogleAuth();
  let sheets = null;
  let docs = null;
  
  if (auth && SPREADSHEET_ID) {
    sheets = google.sheets({ version: 'v4', auth });
    docs = DOC_ID ? google.docs({ version: 'v1', auth }) : null;
    
    const sheetRows = [];
    const docEntries = [];
    const currentDate = formatDate(new Date());
    
    for (const r of newResults) {
      const cleanedName = cleanHorseNameForSheet(r.horse);
      const owner = await lookupOwner(sheets, r.horse);
      const notes = `Place: ${r.place} - ${r.distance} - ${r.hippodrome}`;
      
      sheetRows.push([
        currentDate,
        cleanedName,
        owner,
        sheetHyperlink('Résultat', r.raceUrl),
        notes
      ]);
      
      docEntries.push({
        horseName: cleanedName,
        owner: owner,
        changeType: 'Résultat',
        notes: notes,
        raceUrl: r.raceUrl
      });
    }
    
    if (sheetRows.length > 0) {
      await writeToSheet(sheets, sheetRows);
    }
    
    if (docs && docEntries.length > 0) {
      await appendToDoc(docs, docEntries);
    }
  }

  // ============ DISCORD POSTING ============

  const pending = await loadPendingTracking();

  const today = new Date().toISOString().slice(0, 10);
  const lines = newResults.map(
    r => `• ${formatLink(cleanHorseNameForDiscord(r.horse), r.horseUrl)} - Place: ${r.place} - ${r.distance} - ${cleanCategory(r.cat) || '-'} - ${r.hippodrome} - ${formatLink(r.date, r.raceUrl)}`
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

  const existingRaceUrls = new Set(pending.map(p => p.raceUrl));
  
  for (const r of newResults) {
    if (r.raceUrl && !existingRaceUrls.has(r.raceUrl)) {
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
