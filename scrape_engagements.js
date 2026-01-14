// Node 18+ / 20+; CommonJS. ENV: TRAINER_URL, DISCORD_WEBHOOK_URL, MANUAL_RUN (optional)
// Google Sheets/Docs integration: GOOGLE_SERVICE_ACCOUNT, SPREADSHEET_ID, DOC_ID

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { google } = require('googleapis');

const TRAINER_URL = process.env.TRAINER_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const MANUAL_RUN = process.env.MANUAL_RUN === 'true';
const FORCE_POST = process.env.FORCE_POST === 'true';

// Google integration
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DOC_ID = process.env.DOC_ID;

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
const LAST_RUN_FILE = path.join(STORE_DIR, 'last_run.json');
const PARTANTS_FILE = path.join(STORE_DIR, 'posted_partants.json');

const norm = (s) =>
  (s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[']/g, "'")
    .trim();

const keyify = (obj) =>
  norm([obj.horse, obj.date, obj.track, obj.race, obj.dist].join(' | ')).toLowerCase();

// Clean horse name for Google Sheets: "COCO VANILLE F. 2 a. ... (Sup.)" -> "Coco Vanille"
const cleanHorseNameForSheet = (name) => {
  if (!name) return '';
  
  let cleaned = name;
  
  // Remove (Sup.), (sup.), etc. and everything after
  cleaned = cleaned.replace(/\s*\(Sup\.?\).*$/i, '');
  
  // Remove ... and everything after
  cleaned = cleaned.replace(/\s*\.\.\..*$/, '');
  
  // Remove everything from first country code onwards (GB, IRE, FR, etc.)
  cleaned = cleaned.replace(/\s+(GB|IRE|FR|USA|AUS|GER|ITY|JPN|NZ|ARG|BRZ|CAN|CHI|DEN|HK|IND|KOR|MAC|MEX|NOR|PER|POL|POR|SAF|SIN|SPA|SWE|SWI|TUR|UAE|URU)\b.*/i, '');
  cleaned = cleaned.replace(/\s*\([A-Z]{2,3}\).*$/i, '');
  
  // Remove PS. variations anywhere
  cleaned = cleaned.replace(/\.?P\.?S\./gi, '');
  
  // Remove sex/age pattern: M. 2 A., F 3 a., H. 4 A, F. 2, etc.
  // This handles: "F. 2 a.", "M 3 A", "H. 4", etc.
  cleaned = cleaned.replace(/\s+[MFH]\.?\s*\d+\s*[Aa]?\.?\s*$/i, '');
  
  // Clean up extra spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Title case
  cleaned = cleaned
    .toLowerCase()
    .split(' ')
    .map(word => {
      // Keep Roman numerals uppercase
      if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/i.test(word)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
  
  return cleaned;
};

// Clean status: remove /1234 numbers
const cleanStatus = (status) => {
  if (!status) return '';
  return status.replace(/\/\d+/g, '').trim();
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

// Clean double parentheses from any string (for race names)
const cleanDoubleParens = (str) => {
  if (!str) return '';
  let cleaned = str;
  // Keep replacing until no more double parens
  let prevLength = 0;
  while (cleaned.length !== prevLength) {
    prevLength = cleaned.length;
    cleaned = cleaned.replace(/\(\(/g, '(').replace(/\)\)/g, ')');
  }
  // Also shorten Classe to C in race names
  cleaned = cleaned.replace(/Classe\s*(\d)/gi, 'C$1');
  return cleaned;
};

// Clean horse name for Discord: remove PS. but keep country/sex/age
const cleanHorseNameForDiscord = (name) => {
  if (!name) return '';
  return name.replace(/\.PS\./g, '.').replace(/PS\./g, '').trim();
};

// Format name with optional hyperlink for Discord
const formatLink = (text, url) => {
  if (url && url.startsWith('http')) {
    return '[' + text + '](' + url + ')';
  }
  return text;
};

async function loadSeen() {
  try {
    const txt = await fs.readFile(STORE_FILE, 'utf8');
    return new Map(JSON.parse(txt));
  } catch {
    await fs.mkdir(STORE_DIR, { recursive: true });
    return new Map();
  }
}

async function saveSeen(map) {
  const arr = Array.from(map.entries());
  const trimmed = arr.slice(-3000);
  await fs.writeFile(STORE_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

async function loadLastRun() {
  try {
    const txt = await fs.readFile(LAST_RUN_FILE, 'utf8');
    const data = JSON.parse(txt);
    return data.date;
  } catch {
    return null;
  }
}

async function saveLastRun(date) {
  await fs.writeFile(LAST_RUN_FILE, JSON.stringify({ date }, null, 2), 'utf8');
}

async function loadPostedPartants() {
  try {
    const txt = await fs.readFile(PARTANTS_FILE, 'utf8');
    return new Set(JSON.parse(txt));
  } catch {
    return new Set();
  }
}

async function savePostedPartants(set) {
  const arr = Array.from(set).slice(-1000);
  await fs.writeFile(PARTANTS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

async function saveDPPRaces(races) {
  const dppFile = path.join(STORE_DIR, 'dpp_races.json');
  const timestamp = new Date().toISOString();
  await fs.writeFile(dppFile, JSON.stringify({ 
    lastUpdate: timestamp, 
    races: races 
  }, null, 2), 'utf8');
  console.log('💾 Saved ' + races.length + ' DP-P races for race alerts system');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        range: "'" + tabName + "'!A:Z",
      });
      
      const rows = response.data.values || [];
      if (rows.length === 0) continue;
      
      const headers = rows[0].map(h => (h || '').toString().trim());
      const nameCol = headers.findIndex(h => /^Name$/i.test(h));
      const ownerCol = headers.findIndex(h => /^Propriétaire$/i.test(h));
      
      if (nameCol === -1 || ownerCol === -1) continue;
      
      for (let i = 1; i < rows.length; i++) {
        // Clean the sheet name the same way we clean the scraped name
        const rawSheetName = (rows[i][nameCol] || '').toString().trim();
        const sheetName = cleanHorseNameForSheet(rawSheetName).toLowerCase();
        if (sheetName === cleanedName) {
          return (rows[i][ownerCol] || '').toString().trim();
        }
      }
    } catch (err) {
      console.log('Could not read ' + tabName + ': ' + err.message);
    }
  }
  
  return '';
}

// Create a unique key for deduplication: postDate + horse + raceDate + track
const createSheetKey = (postDate, horseName, notes) => {
  // Extract race date and track from notes: "19/12/2025 — CHANTILLY — ..."
  const match = notes.match(/^(\d{2}\/\d{2}\/\d{4})\s*—\s*([^—]+)/);
  const raceDate = match ? match[1].trim() : '';
  const track = match ? match[2].trim().toUpperCase() : '';
  return postDate + '|' + horseName.toLowerCase() + '|' + raceDate + '|' + track;
};

// Write rows to "Mises à jour" tab - UPDATE existing or INSERT new, with deduplication
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
    const currentDate = formatDate(new Date());
    
    // Read existing data to find rows to update
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Mises à jour'!A:E"
    });
    
    const existingRows = existingData.data.values || [];
    
    // Build a map of existing rows by key (only for today's date)
    const existingByKey = new Map();
    for (let i = 1; i < existingRows.length; i++) { // Skip header row
      const row = existingRows[i];
      if (row[0] === currentDate && row[1] && row[4]) {
        const key = createSheetKey(row[0], row[1], row[4]);
        existingByKey.set(key, { rowIndex: i + 1, row }); // +1 for 1-indexed sheets
      }
    }
    
    // Separate rows into updates and inserts
    const rowsToUpdate = [];
    const rowsToInsert = [];
    
    for (const row of rowsToAdd) {
      const postDate = row[0];
      const horseName = row[1];
      const notes = row[4];
      const key = createSheetKey(postDate, horseName, notes);
      
      const existing = existingByKey.get(key);
      if (existing) {
        // Update existing row
        rowsToUpdate.push({ rowIndex: existing.rowIndex, row });
      } else {
        // Insert new row
        rowsToInsert.push(row);
        // Add to map so subsequent duplicates in same batch update instead of insert
        existingByKey.set(key, { rowIndex: -1, row }); // -1 = pending insert
      }
    }
    
    console.log('📊 Processing: ' + rowsToUpdate.length + ' updates, ' + rowsToInsert.length + ' new inserts');
    
    // Process updates
    for (const { rowIndex, row } of rowsToUpdate) {
      const valuesForSheet = row.map(cell => {
        if (cell && typeof cell === 'object' && cell.text) {
          return cell.text;
        }
        return cell;
      });
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: "'Mises à jour'!A" + rowIndex + ":E" + rowIndex,
        valueInputOption: 'RAW',
        requestBody: {
          values: [valuesForSheet]
        }
      });
      
      // Apply hyperlink formatting to column D
      const linkCell = row[3];
      if (linkCell && typeof linkCell === 'object' && linkCell.url) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [{
              updateCells: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: rowIndex - 1, // 0-indexed
                  endRowIndex: rowIndex,
                  startColumnIndex: 3,
                  endColumnIndex: 4
                },
                rows: [{
                  values: [{
                    userEnteredValue: { stringValue: linkCell.text },
                    textFormatRuns: [{
                      startIndex: 0,
                      format: {
                        link: { uri: linkCell.url },
                        foregroundColor: { red: 0, green: 0, blue: 0 }
                      }
                    }]
                  }]
                }],
                fields: 'userEnteredValue,textFormatRuns'
              }
            }]
          }
        });
      }
    }
    
    // Process inserts (at top, row 2)
    if (rowsToInsert.length > 0) {
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
                endIndex: 1 + rowsToInsert.length
              },
              inheritFromBefore: false
            }
          }]
        }
      });
      
      // Prepare values
      const valuesForSheet = rowsToInsert.map(row => row.map(cell => {
        if (cell && typeof cell === 'object' && cell.text) {
          return cell.text;
        }
        return cell;
      }));
      
      // Write data to row 2
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: "'Mises à jour'!A2:E" + (1 + rowsToInsert.length),
        valueInputOption: 'RAW',
        requestBody: {
          values: valuesForSheet
        }
      });
      
      // Apply formatting
      const requests = [];
      
      // Right-align the date column (column A)
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
            endRowIndex: 1 + rowsToInsert.length,
            startColumnIndex: 0,
            endColumnIndex: 1
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: 'RIGHT'
            }
          },
          fields: 'userEnteredFormat.horizontalAlignment'
        }
      });
      
      for (let i = 0; i < rowsToInsert.length; i++) {
        const linkCell = rowsToInsert[i][3];
        if (linkCell && typeof linkCell === 'object' && linkCell.url) {
          requests.push({
            updateCells: {
              range: {
                sheetId: sheetId,
                startRowIndex: 1 + i,
                endRowIndex: 2 + i,
                startColumnIndex: 3,
                endColumnIndex: 4
              },
              rows: [{
                values: [{
                  userEnteredValue: { stringValue: linkCell.text },
                  textFormatRuns: [{
                    startIndex: 0,
                    format: {
                      link: { uri: linkCell.url },
                      foregroundColor: { red: 0, green: 0, blue: 0 }
                    }
                  }]
                }]
              }],
              fields: 'userEnteredValue,textFormatRuns'
            }
          });
        }
      }
      
      if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests }
        });
      }
    }
    
    console.log('📊 Sheet updated: ' + rowsToUpdate.length + ' updated, ' + rowsToInsert.length + ' inserted');
  } catch (err) {
    console.error('Failed to write to sheet:', err.message);
  }
}

// Write to Google Doc - UPDATE today's section if exists, or INSERT AT TOP
async function appendToDoc(docs, entries) {
  if (!entries || entries.length === 0) return;
  
  try {
    const doc = await docs.documents.get({ documentId: DOC_ID });
    
    // Format date like "16 December 2025"
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                    'July', 'August', 'September', 'October', 'November', 'December'];
    const now = new Date();
    const docDate = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
    const todayHeader = docDate + ' — France Galop';
    
    // Search for today's section in the document
    let todaySectionStart = -1;
    let todaySectionEnd = -1;
    
    // Get document text content
    const docContent = doc.data.body.content;
    let fullText = '';
    const textElements = [];
    
    for (const element of docContent) {
      if (element.paragraph && element.paragraph.elements) {
        for (const elem of element.paragraph.elements) {
          if (elem.textRun && elem.textRun.content) {
            textElements.push({
              text: elem.textRun.content,
              startIndex: elem.startIndex,
              endIndex: elem.endIndex
            });
            fullText += elem.textRun.content;
          }
        }
      }
    }
    
    // Find today's header
    const headerIndex = fullText.indexOf(todayHeader);
    if (headerIndex !== -1) {
      // Find the start of the section (the ═══ line before)
      const beforeHeader = fullText.substring(0, headerIndex);
      const sectionDividerBefore = beforeHeader.lastIndexOf('═══════════════════════════════════════');
      
      if (sectionDividerBefore !== -1) {
        // Find the newline before the divider
        const newlineBefore = beforeHeader.lastIndexOf('\n', sectionDividerBefore);
        todaySectionStart = newlineBefore !== -1 ? newlineBefore : sectionDividerBefore;
      }
      
      // Find the end of today's section (the next ═══ line or end of related content)
      const afterHeader = fullText.substring(headerIndex);
      const nextSectionDivider = afterHeader.indexOf('\n═══════════════════════════════════════', 50); // Skip past current header's divider
      
      if (nextSectionDivider !== -1) {
        todaySectionEnd = headerIndex + nextSectionDivider;
      } else {
        // No next section, find where today's content ends
        // Look for double newline or end of content related to today
        const doubleNewline = afterHeader.indexOf('\n\n\n');
        if (doubleNewline !== -1 && doubleNewline < 2000) {
          todaySectionEnd = headerIndex + doubleNewline + 1;
        }
      }
    }
    
    // If we found today's section, delete it first
    if (todaySectionStart !== -1 && todaySectionEnd !== -1 && todaySectionEnd > todaySectionStart) {
      // Convert text positions to document indices
      // We need to find the actual document indices for these positions
      let charCount = 0;
      let deleteStartIndex = -1;
      let deleteEndIndex = -1;
      
      for (const element of docContent) {
        if (element.paragraph && element.paragraph.elements) {
          for (const elem of element.paragraph.elements) {
            if (elem.textRun && elem.textRun.content) {
              const len = elem.textRun.content.length;
              if (deleteStartIndex === -1 && charCount + len > todaySectionStart) {
                deleteStartIndex = elem.startIndex + (todaySectionStart - charCount);
              }
              if (deleteEndIndex === -1 && charCount + len >= todaySectionEnd) {
                deleteEndIndex = elem.startIndex + (todaySectionEnd - charCount);
              }
              charCount += len;
            }
          }
        }
      }
      
      if (deleteStartIndex !== -1 && deleteEndIndex !== -1 && deleteEndIndex > deleteStartIndex) {
        console.log('📄 Found existing section for ' + docDate + ', replacing...');
        await docs.documents.batchUpdate({
          documentId: DOC_ID,
          requestBody: {
            requests: [{
              deleteContentRange: {
                range: {
                  startIndex: deleteStartIndex,
                  endIndex: deleteEndIndex
                }
              }
            }]
          }
        });
        
        // Refresh doc to get updated indices
        const updatedDoc = await docs.documents.get({ documentId: DOC_ID });
        doc.data = updatedDoc.data;
      }
    }
    
    // Now insert the new content at the top
    let insertIndex = 1;
    if (doc.data.body.content.length > 1) {
      insertIndex = doc.data.body.content[1].startIndex || 1;
    }
    
    // Group entries by owner
    const byOwner = {};
    for (const entry of entries) {
      const ownerKey = entry.owner ? entry.owner.toUpperCase() : 'UNKNOWN OWNER';
      if (!byOwner[ownerKey]) byOwner[ownerKey] = [];
      byOwner[ownerKey].push(entry);
    }
    
    // Build text content and track positions for formatting
    const line1 = '\n═══════════════════════════════════════\n';
    const line2 = docDate + ' — France Galop\n';
    const line3 = '═══════════════════════════════════════\n';
    
    let ownerLines = '';
    const boldRanges = [];      // Ranges that should be bold
    const hyperlinkRanges = []; // Ranges that should be hyperlinks
    
    let currentPos = insertIndex + line1.length + line2.length + line3.length;
    
    // Add header to bold ranges
    boldRanges.push({
      start: insertIndex + line1.length,
      end: insertIndex + line1.length + line2.length + line3.length
    });
    
    for (const [ownerName, ownerEntries] of Object.entries(byOwner)) {
      // Track owner name for bold
      boldRanges.push({ start: currentPos, end: currentPos + ownerName.length });
      
      ownerLines += ownerName + '\n';
      currentPos += ownerName.length + 1;
      
      for (let i = 0; i < ownerEntries.length; i++) {
        const entry = ownerEntries[i];
        const horseName = entry.horseName.toUpperCase();
        const horseLine = '   ' + horseName + '\n';
        
        // Track horse name for bold (after 3 spaces)
        boldRanges.push({ start: currentPos + 3, end: currentPos + 3 + horseName.length });
        
        ownerLines += horseLine;
        currentPos += horseLine.length;
        
        const detailPrefix = '      ';
        const linkText = entry.changeType;
        const detailSuffix = ': ' + entry.notes + '\n';
        
        // Track hyperlink position
        if (entry.raceUrl && entry.raceUrl.startsWith('http')) {
          hyperlinkRanges.push({
            start: currentPos + detailPrefix.length,
            end: currentPos + detailPrefix.length + linkText.length,
            url: entry.raceUrl
          });
        }
        
        ownerLines += detailPrefix + linkText + detailSuffix;
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
    
    // Build formatting requests
    // FIRST: Set entire inserted content to NOT bold
    const formatRequests = [
      {
        updateTextStyle: {
          range: { startIndex: insertIndex, endIndex: insertIndex + fullContent.length },
          textStyle: { bold: false },
          fields: 'bold'
        }
      }
    ];
    
    // THEN: Apply bold only to the specific ranges we tracked
    for (const range of boldRanges) {
      formatRequests.push({
        updateTextStyle: {
          range: { startIndex: range.start, endIndex: range.end },
          textStyle: { bold: true },
          fields: 'bold'
        }
      });
    }
    
    // Apply hyperlinks with black color (not bold)
    for (const hp of hyperlinkRanges) {
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
    
    // Apply formatting
    if (formatRequests.length > 0) {
      await docs.documents.batchUpdate({
        documentId: DOC_ID,
        requestBody: { requests: formatRequests }
      });
    }
    
    console.log('📄 Updated Training Changes Log for ' + docDate);
  } catch (err) {
    console.error('Failed to write to doc:', err.message);
  }
}

// Format date as DD/MM/YY
const formatDate = (date) => {
  const d = date || new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  return day + '/' + month + '/' + year;
};

// Build hyperlink for Google Sheets - just return text, we'll apply link via API
const sheetHyperlink = (text, url) => {
  return { text, url };
};

// ============ SCRAPING ============

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);  // Increased to 60 seconds

  // Retry page load up to 3 times
  let loaded = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log('Loading page (attempt ' + attempt + '/3)...');
      await page.goto(TRAINER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      loaded = true;
      break;
    } catch (err) {
      console.log('Attempt ' + attempt + ' failed: ' + err.message);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 5000));  // Wait 5 seconds before retry
    }
  }

  for (const sel of [
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter tout")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
  ]) {
    const b = page.locator(sel);
    if (await b.count()) { await b.first().click().catch(()=>{}); break; }
  }

  const tab = page.locator('text=Engagements');
  if (await tab.count()) await tab.first().click().catch(()=>{});

  await page.waitForTimeout(1500);

  const allTables = page.locator('table');
  const tableCount = await allTables.count();
  console.log('Found ' + tableCount + ' tables on page, searching for Engagements table...');
  
  let table = null;
  for (let i = 0; i < tableCount; i++) {
    const t = allTables.nth(i);
    const header = norm(await t.locator('thead, tr').first().innerText().catch(()=>'')); 
    if (/Cheval/i.test(header) && /Statut/i.test(header)) { 
      table = t; 
      console.log('✓ Found Engagements table at index ' + i);
      break; 
    }
  }
  if (!table) {
    const sec = page.locator('section:has-text("Engagements")');
    if (await sec.count()) {
      const t = sec.locator('table').first();
      if (await t.count()) {
        table = t;
        console.log('✓ Using table from Engagements section');
      }
    }
  }
  if (!table) {
    console.log('No Engagements table found.');
    await browser.close();
    return [];
  }

  let clickedPlus = false;
  let previousRowCount = 0;
  
  for (let i = 0; i < 20; i++) {
    const currentRowCount = await table.locator('tbody tr, tr').count();
    
    if (i > 0 && currentRowCount === previousRowCount) {
      console.log('Row count unchanged (' + currentRowCount + ' rows) - stopping');
      break;
    }
    
    previousRowCount = currentRowCount;
    
    const tableParent = table.locator('xpath=ancestor::*[self::section or self::div][1]');
    const plusButton = tableParent.locator('button:has-text("Plus"), button:has-text("plus"), a:has-text("Plus"), a:has-text("plus")').first();
    
    if (await plusButton.count() && await plusButton.isVisible().catch(() => false)) {
      console.log('Clicking "Plus" (attempt ' + (i + 1) + ', currently ' + currentRowCount + ' rows)...');
      await plusButton.click().catch(() => {});
      clickedPlus = true;
      await page.waitForTimeout(2000);
    } else {
      if (clickedPlus) console.log('No more Plus button - done (' + currentRowCount + ' rows)');
      break;
    }
  }

  if (clickedPlus) {
    await page.waitForTimeout(2000);
  }

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
    
    let horseUrl = '';
    let raceUrl = '';
    
    if (idx.horse >= 0) {
      const horseLink = row.locator('td').nth(idx.horse).locator('a').first();
      if (await horseLink.count()) {
        const href = await horseLink.getAttribute('href');
        if (href) {
          horseUrl = href.startsWith('http') ? href : 'https://www.france-galop.com' + href;
        }
      }
    }
    
    if (idx.race >= 0) {
      const raceLink = row.locator('td').nth(idx.race).locator('a').first();
      if (await raceLink.count()) {
        const href = await raceLink.getAttribute('href');
        if (href) {
          raceUrl = href.startsWith('http') ? href : 'https://www.france-galop.com' + href;
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
  
  console.log('Scraped ' + out.length + ' valid engagements (skipped ' + skippedCount + ' invalid/empty rows)');

  await browser.close();
  return out;
}

function chunkLines(header, lines, maxLen = 1800) {
  const chunks = [];
  let buf = [];
  let len = header.length + 1;
  for (const ln of lines) {
    if (len + ln.length + 1 > maxLen) {
      chunks.push(header + '\n' + buf.join('\n'));
      buf = [ln];
      len = header.length + 1 + ln.length + 1;
    } else {
      buf.push(ln);
      len += ln.length + 1;
    }
  }
  if (buf.length) chunks.push(header + '\n' + buf.join('\n'));
  return chunks;
}

(async () => {
  const seen = await loadSeen();
  const postedPartants = await loadPostedPartants();
  const lastRunDate = await loadLastRun();
  const today = new Date().toISOString().slice(0, 10);
  const isFirstRunToday = lastRunDate !== today;
  
  if (isFirstRunToday) {
    console.log('✨ First run of the day - will post all PARTANTS');
  }
  
  const rows = await scrape();

  const runSeen = new Set();
  const unique = [];
  for (const r of rows) {
    const k = keyify(r);
    if (!runSeen.has(k)) { runSeen.add(k); unique.push(r); }
  }

  const newRows = [];
  const changedRows = [];

  for (const r of unique) {
    const k = keyify(r);
    const prev = seen.get(k);
    
    if (FORCE_POST) {
      newRows.push(r);
      seen.set(k, { statut: r.statut, last: Date.now(), horseUrl: r.horseUrl, raceUrl: r.raceUrl });
    } else if (!prev) {
      newRows.push(r);
      seen.set(k, { statut: r.statut, last: Date.now(), horseUrl: r.horseUrl, raceUrl: r.raceUrl });
    } else if (prev.statut !== r.statut) {
      changedRows.push({ ...r, oldStatut: prev.statut });
      seen.set(k, { statut: r.statut, last: Date.now(), horseUrl: r.horseUrl, raceUrl: r.raceUrl });
    } else {
      seen.set(k, { statut: prev.statut, last: Date.now(), horseUrl: r.horseUrl, raceUrl: r.raceUrl });
    }
  }

  let declaredParticipants = [];
  if (isFirstRunToday) {
    declaredParticipants = unique.filter(r => /^DP-P/i.test(r.statut));
  } else {
    const newDPP = newRows.filter(r => /^DP-P/i.test(r.statut));
    const changedToDPP = changedRows.filter(r => /^DP-P/i.test(r.statut));
    declaredParticipants = [...newDPP, ...changedToDPP];
  }
  
  const allCurrentDPP = unique.filter(r => /^DP-P/i.test(r.statut));
  await saveDPPRaces(allCurrentDPP);
  
  // ============ GOOGLE SHEETS/DOCS INTEGRATION ============
  
  const auth = await getGoogleAuth();
  let sheets = null;
  let docs = null;
  
  if (auth && SPREADSHEET_ID) {
    sheets = google.sheets({ version: 'v4', auth });
    docs = DOC_ID ? google.docs({ version: 'v1', auth }) : null;
    
    const currentDate = formatDate(new Date());
    
    // Collect all entries for deduplication
    // Key: horse + raceDate + track, Value: { entry data, isPartant }
    const entriesMap = new Map();
    
    // Helper to create dedup key from race info
    const createDedupKey = (r) => {
      const cleanedName = cleanHorseNameForSheet(r.horse).toLowerCase();
      const track = (r.track || '').toUpperCase().trim();
      return cleanedName + '|' + r.date + '|' + track;
    };
    
    // Helper to add/update entry in map (Partant takes priority)
    const addOrUpdateEntry = async (r, isPartant) => {
      const key = createDedupKey(r);
      const existing = entriesMap.get(key);
      
      // If already a Partant, don't downgrade to Engagement
      if (existing && existing.isPartant && !isPartant) {
        return;
      }
      
      const cleanedName = cleanHorseNameForSheet(r.horse);
      const owner = await lookupOwner(sheets, r.horse);
      const cleanedStatus = cleanStatus(r.statut);
      const notes = cleanDoubleParens(r.date + ' — ' + r.track + ' — ' + r.race + ' (' + (cleanCategory(r.cat) || '-') + ') — ' + (r.dist || '-') + ' — Statut: ' + cleanedStatus);
      
      entriesMap.set(key, {
        cleanedName,
        owner,
        changeType: isPartant ? 'Partant' : 'Engagement',
        notes,
        raceUrl: r.raceUrl,
        isPartant
      });
    };
    
    // Process new engagements
    for (const r of newRows) {
      const isPartant = /^DP-P/i.test(r.statut);
      await addOrUpdateEntry(r, isPartant);
    }
    
    // Process status changes (use final status only, no arrows)
    for (const r of changedRows) {
      const isPartant = /^DP-P/i.test(r.statut);
      await addOrUpdateEntry(r, isPartant);
    }
    
    // Process Partants (DP-P) - these always take priority
    for (const r of allCurrentDPP) {
      const partantKey = keyify(r);
      if (!postedPartants.has(partantKey)) {
        await addOrUpdateEntry(r, true);
        postedPartants.add(partantKey);
      }
    }
    
    // Convert map to arrays for Sheet and Doc
    const sheetRows = [];
    const docEntries = [];
    
    for (const [key, entry] of entriesMap) {
      sheetRows.push([
        currentDate,
        entry.cleanedName,
        entry.owner,
        sheetHyperlink(entry.changeType, entry.raceUrl),
        entry.notes
      ]);
      
      docEntries.push({
        horseName: entry.cleanedName,
        owner: entry.owner,
        changeType: entry.changeType,
        notes: entry.notes,
        raceUrl: entry.raceUrl
      });
    }
    
    // Write to Google Sheet
    if (sheetRows.length > 0) {
      await writeToSheet(sheets, sheetRows);
    }
    
    // Write to Google Doc
    if (docs && docEntries.length > 0) {
      await appendToDoc(docs, docEntries);
    }
    
    await savePostedPartants(postedPartants);
  }
  
  // ============ DISCORD POSTING ============
  
  if (newRows.length === 0 && changedRows.length === 0 && declaredParticipants.length === 0) {
    console.log('No new/changed engagements — nothing to post to Discord.');
    await saveSeen(seen);
    await saveLastRun(today);
    process.exit(0);
  }
  
  const linesDPP = declaredParticipants.map(
    r => '• ' + formatLink(cleanHorseNameForDiscord(r.horse), r.horseUrl) + ' — ' + r.date + ' — ' + r.track + ' — ' + formatLink(cleanDoubleParens(r.race), r.raceUrl) + ' (' + (cleanCategory(r.cat) || '-') + ') — ' + (r.dist || '-') + ' — Statut: ' + cleanStatus(r.statut)
  );
  
  const linesNew = newRows.map(
    r => '• ' + formatLink(cleanHorseNameForDiscord(r.horse), r.horseUrl) + ' — ' + r.date + ' — ' + r.track + ' — ' + formatLink(cleanDoubleParens(r.race), r.raceUrl) + ' (' + (cleanCategory(r.cat) || '-') + ') — ' + (r.dist || '-') + ' — Statut: ' + cleanStatus(r.statut)
  );
  
  const linesUpd = changedRows.map(
    r => '• ' + formatLink(cleanHorseNameForDiscord(r.horse), r.horseUrl) + ' — ' + r.date + ' — ' + r.track + ' — ' + formatLink(cleanDoubleParens(r.race), r.raceUrl) + ' (' + (cleanCategory(r.cat) || '-') + ') — ' + (r.dist || '-') + ' — Statut: ' + cleanStatus(r.oldStatut) + ' → ' + cleanStatus(r.statut)
  );

  const payloads = [];
  
  if (linesDPP.length) {
    payloads.push(...chunkLines('🏇 **PARTANTS — ' + today + '**', linesDPP));
  }
  
  if (linesNew.length) {
    payloads.push(...chunkLines('🆕 **Nouvelles engagements — ' + today + '**', linesNew));
  }
  
  if (linesUpd.length) {
    payloads.push(...chunkLines('🔄 **Statut mis à jour — ' + today + '**', linesUpd));
  }

  for (const content of payloads) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        content, 
        allowed_mentions: { parse: [] },
        flags: 4  // Suppress embeds
      }),
    });
    if (!res.ok) {
      console.error('Discord webhook failed', await res.text());
      process.exit(2);
    }
  }

  await saveSeen(seen);
  await saveLastRun(today);
  console.log('✅ Posted ' + declaredParticipants.length + ' declared participants + ' + newRows.length + ' new + ' + changedRows.length + ' updated engagements');
})();
