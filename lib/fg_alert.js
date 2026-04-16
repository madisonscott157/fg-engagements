// Post a login-failure message to Discord so the outage is visible
// immediately rather than hiding behind a green CI run.
//
// Each scraper owns its own webhook (engagements, results, race alerts,
// tracking). Pass the webhook URL explicitly — no global fallback, since
// that silently loses alerts when the caller's webhook isn't DISCORD_WEBHOOK_URL.

async function sendLoginFailureAlert(scriptName, errorMessage, webhookUrl) {
  if (!webhookUrl) {
    console.error('sendLoginFailureAlert: no webhook URL supplied — cannot post alert.');
    return;
  }

  const payload = {
    content:
      '🚨 **France Galop login failed** (`' + scriptName + '`)\n' +
      '```' + String(errorMessage || 'Unknown error').slice(0, 1500) + '```',
    allowed_mentions: { parse: [] },
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('Alert webhook returned', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('Failed to post login-failure alert:', e.message);
  }
}

module.exports = { sendLoginFailureAlert };
