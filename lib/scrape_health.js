// Consecutive-failure tracking for the scrapers.
//
// France Galop is intermittently unreachable from GitHub runners — most often
// during its overnight maintenance window. Historically a single unreachable
// cycle killed the run with an unhandled rejection, turning CI red and emailing
// a failure notice for something that self-healed on the next cycle.
//
// These helpers let a scraper treat a short outage as a skipped cycle (exit 0)
// while still going loudly red once the site has been unreachable for several
// consecutive runs, which is a genuinely actionable condition.
//
// Each scraper gets its own state file so that concurrently running workflows
// never contend over the same JSON blob when committing back to the repo.

const fs = require('fs/promises');
const path = require('path');

const STORE_DIR = 'data';

/**
 * @param {string} scraper - Short scraper name, e.g. 'results'.
 * @returns {string} Path to that scraper's health file.
 */
function healthFile(scraper) {
  return path.join(STORE_DIR, `scrape_health_${scraper}.json`);
}

/**
 * @param {string} scraper - Short scraper name.
 * @returns {Promise<{consecutiveFailures: number, lastFailure: string|null}>}
 */
async function loadHealth(scraper) {
  try {
    const parsed = JSON.parse(await fs.readFile(healthFile(scraper), 'utf8'));
    return {
      consecutiveFailures: Number(parsed.consecutiveFailures) || 0,
      lastFailure: parsed.lastFailure || null,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not read health file: ${err.message}`);
    return { consecutiveFailures: 0, lastFailure: null };
  }
}

/**
 * Reset the consecutive-failure counter after a healthy run.
 *
 * @param {string} scraper - Short scraper name.
 * @returns {Promise<void>}
 */
async function recordSuccess(scraper) {
  const current = await loadHealth(scraper);
  if (current.consecutiveFailures === 0) return;  // avoid a pointless commit
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(
    healthFile(scraper),
    JSON.stringify({ consecutiveFailures: 0, lastFailure: current.lastFailure }, null, 2) + '\n',
  );
  console.log(`Recovered after ${current.consecutiveFailures} consecutive failure(s).`);
}

/**
 * Terminal error handler for a scraper's top-level promise.
 *
 * Errors tagged `siteUnreachable` are treated as a skipped cycle until the
 * scraper has missed `threshold` runs in a row; everything else (login
 * failures, parse errors, webhook errors) stays loud and exits non-zero.
 *
 * Exits the process — never returns.
 *
 * @param {string} scraper - Short scraper name.
 * @param {Error} err - The error that ended the run.
 * @param {{threshold?: number}} [options] - Consecutive misses tolerated before escalating.
 * @returns {Promise<never>}
 */
async function handleScrapeFailure(scraper, err, options = {}) {
  const threshold = options.threshold || 5;

  if (!err || !err.siteUnreachable) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }

  const summary = String(err.message).split('\n')[0];
  const { consecutiveFailures } = await loadHealth(scraper);
  const count = consecutiveFailures + 1;

  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(
    healthFile(scraper),
    JSON.stringify({ consecutiveFailures: count, lastFailure: new Date().toISOString() }, null, 2) + '\n',
  );

  if (count < threshold) {
    console.warn(`⚠️  Site unreachable (${summary})`);
    console.warn(`   Consecutive miss ${count}/${threshold} — skipping this cycle, will retry on the next run.`);
    process.exit(0);
  }

  console.error(`❌ Site unreachable for ${count} consecutive runs (${summary})`);
  console.error('   This is past the tolerated threshold — failing loudly.');
  process.exit(1);
}

module.exports = { loadHealth, recordSuccess, handleScrapeFailure };
