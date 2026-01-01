// build_dashboard_data.js
// Reads from Google Sheets and outputs dashboard_data.json
// Run after scrapers via GitHub Action

const { google } = require('googleapis');
const fs = require('fs/promises');
const path = require('path');

const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!GOOGLE_SERVICE_ACCOUNT || !SPREADSHEET_ID) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT or SPREADSHEET_ID');
  process.exit(1);
}

const STORE_DIR = 'data';
const OUTPUT_FILE = path.join(STORE_DIR, 'dashboard_data.json');

// Clean horse name: "COCO VANILLE F. 2 a. ... (Sup.)" -> "Coco Vanille"
const cleanHorseName = (name) => {
  if (!name) return '';
  
  let cleaned = name;
  
  // Remove (Sup.), (sup.), etc.
  cleaned = cleaned.replace(/\s*\(Sup\.?\).*$/i, '');
  
  // Remove ... and everything after
  cleaned = cleaned.replace(/\s*\.\.\..*$/, '');
  
  // Remove country codes
  cleaned = cleaned.replace(/\s+(GB|IRE|FR|USA|AUS|GER|ITY|JPN|NZ|ARG|BRZ|CAN|CHI|DEN|HK|IND|KOR|MAC|MEX|NOR|PER|POL|POR|SAF|SIN|SPA|SWE|SWI|TUR|UAE|URU)\b.*/i, '');
  cleaned = cleaned.replace(/\s*\([A-Z]{2,3}\).*$/i, '');
  
  // Remove PS. variations
  cleaned = cleaned.replace(/\.?P\.?S\./gi, '');
  
  // Remove sex/age pattern: M. 2 A., F 3 a., etc.
  cleaned = cleaned.replace(/\s+[MFH]\.?\s*\d+\s*[Aa]?\.?\s*$/i, '');
  
  // Clean up extra spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Title case
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

// Parse date from DD/MM/YYYY to ISO
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }
  return dateStr;
};

async function getGoogleAuth() {
  try {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    return auth;
  } catch (err) {
    console.error('Failed to parse Google credentials:', err.message);
    return null;
  }
}

async function readMisesAJour(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Mises à jour'!A:E`,
    });
    
    const rows = response.data.values || [];
    if (rows.length <= 1) {
      console.log('No data in Mises à jour tab');
      return { results: [], engagements: [], partants: [] };
    }
    
    // Skip header row
    const results = [];
    const engagements = [];
    const partants = [];
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 4) continue;
      
      const [postDate, horse, owner, changeType, notes] = row;
      
      if (!horse || !changeType) continue;
      
      // Parse notes: "19/12/2025 — CHANTILLY — Prix ABC (C2) — 1600m — Statut: DP-P"
      // Or for results: "Place: 2nd - 1600m - C2 - CHANTILLY"
      const entry = {
        horse: cleanHorseName(horse),
        owner: owner || '',
        type: changeType,
        postDate: postDate || '',
        raw: notes || ''
      };
      
      // Parse based on type
      if (changeType === 'Résultat') {
        // Notes format: "Place: 2nd - 1600m - C2 - CHANTILLY - 19/12/2025"
        const placeMatch = notes?.match(/Place:\s*(\S+)/i);
        const distMatch = notes?.match(/(\d[\d.,]*)\s*m?\s*-/);
        const trackMatch = notes?.match(/-\s*([A-Z][A-Z\s-]+[A-Z])\s*-/i);
        const dateMatch = notes?.match(/(\d{2}\/\d{2}\/\d{4})/);
        
        entry.position = placeMatch ? placeMatch[1] : '';
        entry.distance = distMatch ? distMatch[1] : '';
        entry.track = trackMatch ? trackMatch[1].trim() : '';
        entry.date = dateMatch ? parseDate(dateMatch[1]) : '';
        
        results.push(entry);
      } else if (changeType === 'Partant') {
        // Notes format: "19/12/2025 — CHANTILLY — Prix ABC (C2) — 1600m — Statut: DP-P"
        const parts = (notes || '').split('—').map(s => s.trim());
        
        entry.date = parts[0] ? parseDate(parts[0]) : '';
        entry.track = parts[1] || '';
        entry.race = parts[2] || '';
        entry.distance = parts[3] || '';
        entry.status = parts[4] ? parts[4].replace(/Statut:\s*/i, '') : '';
        
        partants.push(entry);
      } else if (changeType === 'Engagement') {
        // Same format as Partant
        const parts = (notes || '').split('—').map(s => s.trim());
        
        entry.date = parts[0] ? parseDate(parts[0]) : '';
        entry.track = parts[1] || '';
        entry.race = parts[2] || '';
        entry.distance = parts[3] || '';
        entry.status = parts[4] ? parts[4].replace(/Statut:\s*/i, '') : '';
        
        engagements.push(entry);
      }
    }
    
    return { results, engagements, partants };
  } catch (err) {
    console.error('Error reading Mises à jour:', err.message);
    return { results: [], engagements: [], partants: [] };
  }
}

// Also read DPP from local file if available (more reliable for upcoming)
async function readLocalDPP() {
  try {
    const dppFile = path.join(STORE_DIR, 'dpp_races.json');
    const data = JSON.parse(await fs.readFile(dppFile, 'utf8'));
    return data.races || [];
  } catch {
    return [];
  }
}

// Read seen.json for engagement history
async function readLocalEngagements() {
  try {
    const seenFile = path.join(STORE_DIR, 'seen.json');
    const data = JSON.parse(await fs.readFile(seenFile, 'utf8'));
    // data is array of [key, {statut, last}]
    return data.map(([key, val]) => {
      const parts = key.split(' | ');
      return {
        horse: cleanHorseName(parts[0] || ''),
        date: parts[1] || '',
        track: parts[2] || '',
        race: parts[3] || '',
        distance: parts[4] || '',
        status: val.statut || '',
        lastUpdate: val.last
      };
    });
  } catch {
    return [];
  }
}

(async () => {
  console.log('🔄 Building dashboard data from Google Sheet...');
  
  await fs.mkdir(STORE_DIR, { recursive: true });
  
  const auth = await getGoogleAuth();
  if (!auth) {
    console.error('Failed to authenticate with Google');
    process.exit(1);
  }
  
  const sheets = google.sheets({ version: 'v4', auth });
  
  // Read from Google Sheet
  const sheetData = await readMisesAJour(sheets);
  
  // Read local files for additional data
  const localDPP = await readLocalDPP();
  const localEngagements = await readLocalEngagements();
  
  // Merge and deduplicate
  // For upcoming: prefer local DPP (more structured), supplement with sheet partants
  const upcomingMap = new Map();
  
  // Add local DPP first
  for (const r of localDPP) {
    const key = `${cleanHorseName(r.horse)}|${r.date}|${r.track}`.toLowerCase();
    upcomingMap.set(key, {
      horse: cleanHorseName(r.horse),
      date: parseDate(r.date),
      track: r.track || '',
      race: r.race || '',
      distance: r.dist || '',
      category: r.cat || '',
      status: r.statut || 'DP-P',
      horseUrl: r.horseUrl || '',
      raceUrl: r.raceUrl || ''
    });
  }
  
  // Add sheet partants if not already present
  for (const r of sheetData.partants) {
    const key = `${r.horse}|${r.date}|${r.track}`.toLowerCase();
    if (!upcomingMap.has(key)) {
      upcomingMap.set(key, {
        horse: r.horse,
        date: r.date,
        track: r.track,
        race: r.race,
        distance: r.distance,
        category: '',
        status: r.status || 'DP-P',
        horseUrl: '',
        raceUrl: ''
      });
    }
  }
  
  // Build results list (most recent first)
  const resultsMap = new Map();
  for (const r of sheetData.results) {
    const key = `${r.horse}|${r.date}|${r.track}`.toLowerCase();
    if (!resultsMap.has(key)) {
      resultsMap.set(key, {
        horse: r.horse,
        date: r.date,
        track: r.track,
        distance: r.distance,
        position: r.position,
        category: '',
        owner: r.owner
      });
    }
  }
  
  // Build engagements list
  const engagementsMap = new Map();
  for (const r of [...localEngagements, ...sheetData.engagements]) {
    const key = `${r.horse}|${r.date}|${r.track}`.toLowerCase();
    if (!engagementsMap.has(key)) {
      engagementsMap.set(key, {
        horse: r.horse || cleanHorseName(r.horse),
        date: parseDate(r.date),
        track: r.track,
        race: r.race,
        distance: r.distance,
        status: r.status,
        owner: r.owner || ''
      });
    }
  }
  
  // Sort: upcoming by date asc, results by date desc
  const upcoming = Array.from(upcomingMap.values())
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  
  const results = Array.from(resultsMap.values())
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 100); // Keep last 100 results
  
  const engagements = Array.from(engagementsMap.values())
    .filter(e => !upcomingMap.has(`${e.horse}|${e.date}|${e.track}`.toLowerCase())) // Exclude DP-P
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .slice(0, 50); // Keep next 50 engagements
  
  const dashboardData = {
    lastUpdate: new Date().toISOString(),
    upcoming,      // DP-P horses (confirmed starters)
    engagements,   // Other engagements (not yet confirmed)
    results        // Past race results
  };
  
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(dashboardData, null, 2), 'utf8');
  
  console.log(`✅ Built dashboard_data.json:`);
  console.log(`   - ${upcoming.length} upcoming (DP-P)`);
  console.log(`   - ${engagements.length} engagements`);
  console.log(`   - ${results.length} results`);
})();
