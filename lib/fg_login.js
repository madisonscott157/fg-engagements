// France Galop login helper.
//
// France Galop delegates auth to Microsoft Entra External ID (CIAM).
// Flow: www.france-galop.com → francegalopext.ciamlogin.com
//   1. UsernameViewForm: input[name="username"] → #usernamePrimaryButton (Next)
//   2. Password view:    input[name="passwd"]   → #idSIButton9          (Sign in)
//   3. Optional KMSI "Stay signed in?" → click a submit (either Yes or No fine)
//   4. Redirect back to www.france-galop.com/fr/openid-connect/sso?code=... which
//      sets the site session cookie and lands on the requested page.
//
// We persist storageState to .fg-session.json at repo root so subsequent runs
// reuse cookies and skip the login flow entirely. On rejection we delete the
// cache and re-login once.

const fs = require('fs').promises;
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', '.fg-session.json');
const CIAM_HOST_RE = /ciamlogin\.com/i;

async function sessionFileExists() {
  try { await fs.access(SESSION_FILE); return true; } catch { return false; }
}

async function loadSessionStorageState() {
  if (!(await sessionFileExists())) return undefined;
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Playwright storageState has { cookies, origins }; sanity check
    if (parsed && Array.isArray(parsed.cookies)) return parsed;
  } catch (e) {
    console.warn('⚠️ Could not read session cache:', e.message);
  }
  return undefined;
}

async function saveSessionStorageState(context) {
  try {
    const state = await context.storageState();
    await fs.writeFile(SESSION_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn('⚠️ Could not save session cache:', e.message);
  }
}

async function clearSession() {
  try { await fs.unlink(SESSION_FILE); } catch {}
}

function onCiamPage(page) {
  return CIAM_HOST_RE.test(page.url());
}

// Some France Galop pages auto-redirect to CIAM; /fr/login itself does.
// Treat either as "auth required".
function authRequired(page) {
  const u = page.url();
  return CIAM_HOST_RE.test(u) || /\/fr\/login(\/|$|\?)/i.test(u);
}

async function dismissCookieBanner(page) {
  for (const sel of [
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter tout")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
  ]) {
    try {
      const b = page.locator(sel);
      if (await b.count()) { await b.first().click({ timeout: 3000 }); break; }
    } catch {}
  }
}

async function performCiamLogin(page, email, password) {
  try { await page.waitForURL(CIAM_HOST_RE, { timeout: 20000 }); } catch {}
  if (!onCiamPage(page)) {
    throw new Error('Expected redirect to CIAM, got: ' + page.url());
  }

  // --- Email step ---
  const emailInput = page.locator('input[name="username"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 20000 });
  await emailInput.fill(email);

  const nextBtn = page.locator(
    'button#usernamePrimaryButton, ' +
    'button[type="submit"]:has-text("Next"), ' +
    'button:has-text("Next"), ' +
    'button:has-text("Suivant")'
  ).first();
  await nextBtn.click();

  // Wait for either the password input or an email-error to appear.
  await Promise.race([
    page.waitForSelector('input[name="passwd"], input[type="password"]', { state: 'visible', timeout: 20000 }),
    page.waitForSelector('#usernameError', { state: 'visible', timeout: 20000 }),
  ]).catch(() => {});

  const emailErr = page.locator('#usernameError');
  if (await emailErr.count()) {
    const txt = (await emailErr.first().innerText().catch(() => '')).trim();
    if (txt) throw new Error('CIAM rejected email: ' + txt);
  }

  // --- Password step ---
  const passInput = page.locator('input[name="passwd"], input[type="password"]').first();
  await passInput.waitFor({ state: 'visible', timeout: 15000 });
  await passInput.fill(password);

  const signInBtn = page.locator(
    'button#idSIButton9, ' +
    'button[type="submit"]:has-text("Sign in"), ' +
    'button:has-text("Sign in"), ' +
    'button:has-text("Se connecter")'
  ).first();

  await Promise.all([
    page.waitForURL(u => !CIAM_HOST_RE.test(u.toString()), { timeout: 45000 }).catch(() => {}),
    signInBtn.click(),
  ]);

  // If still on CIAM, we're either on the KMSI "Stay signed in?" interstitial
  // OR login just failed (wrong password, locked, etc.) and we're still on the
  // password view. MS reuses button#idSIButton9 as the primary CTA on both
  // views, so we MUST disambiguate before clicking — a blind re-click would
  // double-submit bad credentials and can lock the account.
  if (onCiamPage(page)) {
    const passStillVisible = await page
      .locator('input[name="passwd"], input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (passStillVisible) {
      // Still on password view → login rejected. Surface the error, don't retry.
      const errTxt = await page
        .locator('#passwordError, [role="alert"]')
        .first()
        .innerText()
        .catch(() => '');
      throw new Error(
        'CIAM rejected password. Details: ' + (errTxt.trim() || '(none visible)')
      );
    }

    // Password field gone but still on CIAM → KMSI "Stay signed in?" view.
    // MS renders the primary button here as an <input type="submit"> (not a
    // <button>), so match by id regardless of tag. Clicking either Yes or No
    // redirects back to france-galop.com — we use the primary button which
    // is visible and the simpler target.
    const kmsi = page.locator('#idSIButton9').first();
    if (await kmsi.count()) {
      await Promise.all([
        page.waitForURL(u => !CIAM_HOST_RE.test(u.toString()), { timeout: 30000 }).catch(() => {}),
        kmsi.click().catch(() => {}),
      ]);
    }
  }

  // Catchall: if we're somehow still on CIAM after KMSI handling, fail loud.
  if (onCiamPage(page)) {
    throw new Error('CIAM login flow did not redirect back to france-galop.com. Final URL: ' + page.url());
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
}

/**
 * Ensure the current page is an authenticated France Galop page.
 * - If we're already on a site page (not auth), returns immediately.
 * - If we're on an auth page, runs the CIAM flow and then navigates to targetUrl.
 * Throws on any failure. Callers must handle the throw (alert + exit 1).
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {{ email: string, password: string, targetUrl?: string }} opts
 */
async function ensureLoggedIn(page, context, { email, password, targetUrl }) {
  if (!email || !password) {
    throw new Error('FRANCE_GALOP_EMAIL and FRANCE_GALOP_PASSWORD must be set');
  }

  // Always route through /fr/account, regardless of the caller's current
  // page state. This is the canonical post-login landing page; visiting it
  // first ensures app-level session cookies are set before we navigate to
  // any resource page. Skipping this step (e.g. going directly from a
  // cached session or a fresh OIDC callback to /fr/entraineur/XXX) makes FG
  // re-trigger SSO and render "Accès refusé" instead of the target.
  await page.goto('https://www.france-galop.com/fr/account', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await dismissCookieBanner(page);

  if (authRequired(page)) {
    console.log('🔐 Auth required — performing CIAM login...');
    await performCiamLogin(page, email, password);

    // After OIDC callback, re-land on /fr/account so the session is settled.
    await page.goto('https://www.france-galop.com/fr/account', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => {});
    await dismissCookieBanner(page);

    await saveSessionStorageState(context);
    console.log('✓ CIAM login successful. Session cached.');
  }

  if (targetUrl) {
    const targetPath = new URL(targetUrl).pathname;
    if (!page.url().includes(targetPath)) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await dismissCookieBanner(page);
    }
    const title = await page.title().catch(() => '');
    if (authRequired(page) || /Accès refusé/i.test(title)) {
      throw new Error('Access denied / re-auth required for ' + targetUrl + ' (title: ' + title + ')');
    }
  }
}

module.exports = {
  ensureLoggedIn,
  loadSessionStorageState,
  saveSessionStorageState,
  clearSession,
  authRequired,
  dismissCookieBanner,
  SESSION_FILE,
};
