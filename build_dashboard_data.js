// build_dashboard_data.js
// Combines all scraped data into a single dashboard_data.json for the frontend
// Run by GitHub Actions after scraping

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = 'data';
const OUTPUT_FILE = path.join(DATA_DIR, 'dashboard_data.json');

// Input files from scrapers
const SEEN_FILE = path.join(DATA_DIR, 'seen.json');
const RACE_HISTORY = path.join(DATA_DIR, 'race_history.json');
const STORED_RACES = path.join(DATA_DIR, 'stored_races.json');

async function loadJSON(filepath, defaultValue) {
  try {
    const content = await fs.readFile(filepath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.log('Could not load ' + filepath + ': ' + err.message);
    return defaultValue;
  }
}

function parseEngagements(seenData) {
  const engagements = [];

  for (const [key, value] of seenData) {
    const parts = key.split(' | ');
    if (parts.length >= 5) {
      let horseName = parts[0];
      horseName = horseName.replace(/\s+(gb|ire|fr|usa)\s+/gi, ' ');
      horseName = horseName.replace(/\s+[mfh]\.?\s*\d+\s*a?\.?\s*$/i, '');
      horseName = horseName.replace(/\.?p\.?s\./gi, '');
      horseName = horseName.replace(/\s*\(sup\.?\)/gi, '');
      horseName = horseName.replace(/\s*\.\.\..*$/, '');
      horseName = horseName.trim();

      horseName = horseName
        .toLowerCase()
        .split(' ')
        .map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); })
        .join(' ');

      engagements.push({
        horse: horseName,
        date: parts[1],
        track: parts[2],
        race: parts[3],
        distance: parts[4],
        status: value.statut || '',
        lastUpdate: value.last
      });
    }
  }

  engagements.sort(function(a, b) {
    const dateA = parseDate(a.date);
    const dateB = parseDate(b.date);
    return dateB - dateA;
  });

  return engagements;
}

function parseDate(dateStr) {
  if (!dateStr) return new Date(0);
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return new Date(parts[2], parts[1] - 1, parts[0]);
  }
  return new Date(dateStr);
}

function parseUpcoming(storedRaces) {
  if (!storedRaces || !storedRaces.races) return [];

  return storedRaces.races.map(function(r) {
    return {
      horse: r.horse || '',
      date: r.date || '',
      track: r.track || r.hippodrome || '',
      race: r.race || r.raceName || '',
      distance: r.distance || r.dist || '',
      cat: r.cat || '',
      raceUrl: r.raceUrl || '',
      horseUrl: r.horseUrl || ''
    };
  });
}

(async function() {
  console.log('Building dashboard data...\n');

  const seenData = await loadJSON(SEEN_FILE, []);
  const raceHistory = await loadJSON(RACE_HISTORY, []);
  const storedRaces = await loadJSON(STORED_RACES, { races: [] });

  const raceCount = storedRaces.races ? storedRaces.races.length : 0;
  console.log('Loaded:');
  console.log('  - ' + seenData.length + ' engagement records');
  console.log('  - ' + raceHistory.length + ' race history records');
  console.log('  - ' + raceCount + ' upcoming races');

  const engagements = parseEngagements(seenData);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const futureEngagements = engagements.filter(function(e) {
    return parseDate(e.date) >= today;
  });

  const upcoming = parseUpcoming(storedRaces);

  const results = raceHistory.map(function(r) {
    return {
      horse: r.horse || '',
      date: r.date || '',
      track: r.track || '',
      race: r.race || '',
      distance: r.distance || '',
      position: r.position || '',
      jockey: r.jockey || '',
      gain: r.gain || '',
      raceUrl: r.raceUrl || '',
      horseUrl: r.horseUrl || ''
    };
  });

  const dashboardData = {
    lastUpdate: new Date().toISOString(),
    upcoming: upcoming,
    engagements: futureEngagements,
    results: results
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(dashboardData, null, 2), 'utf8');

  console.log('\nBuilt dashboard_data.json:');
  console.log('  - ' + dashboardData.upcoming.length + ' upcoming races');
  console.log('  - ' + dashboardData.engagements.length + ' future engagements');
  console.log('  - ' + dashboardData.results.length + ' race results (with URLs)');
  console.log('\nDone!');
})();
