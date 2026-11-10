/**
 * ============================================================
 * SECRETS.GS — credential resolution
 * ============================================================
 *
 * Two ways to authenticate to Bitrix24, chosen at runtime by
 * the BITRIX_AUTH_MODE script property:
 *
 *   "oauth"    a local application's access token (see OAuth.gs)
 *   "webhook"  the legacy inbound webhook URL, below
 *
 * OAuth is the intended mode. The webhook path is kept so that
 * a production problem can be rolled back by changing one
 * property, without editing or redeploying code.
 *
 * getAuthContext_() is the single place credentials are
 * resolved; nothing outside this file and OAuth.gs needs to
 * know which mode is active.
 *
 * ------------------------------------------------------------
 * THE WEBHOOK (fallback mode)
 * ------------------------------------------------------------
 * A Bitrix24 inbound webhook URL is a bearer credential. Anyone
 * holding it can read and write your entire CRM. It must never
 * appear in source code, because:
 *
 *   - anyone with edit access to the Sheet can open
 *     Extensions > Apps Script and read it
 *   - it persists in Apps Script version history
 *   - it travels with any copy of the spreadsheet
 *
 * It is stored in Script Properties instead, which is not
 * visible to sheet viewers/editors — only to script editors.
 *
 * ------------------------------------------------------------
 * ONE-TIME SETUP
 * ------------------------------------------------------------
 * Preferred (nothing typed into code at all):
 *
 *   Apps Script editor > Project Settings (gear icon)
 *   > Script Properties > Add script property
 *
 *   Property:  BITRIX_WEBHOOK_URL
 *   Value:     https://YOUR_PORTAL.bitrix24.com/rest/<userId>/<token>/
 *
 * Alternative: temporarily paste the URL into setWebhookUrl_()
 * below, run it once, then DELETE the value and save. Note that
 * the pasted value will remain in version history, so rotating
 * the webhook afterwards is wise.
 * ============================================================
 */

const WEBHOOK_PROPERTY_KEY = 'BITRIX_WEBHOOK_URL';
const AUTH_MODE_PROPERTY_KEY = 'BITRIX_AUTH_MODE';

/**
 * Which credential mode is active.
 *
 * Defaults to "webhook" so that pasting these files into a
 * project that has not been through OAuth setup yet keeps
 * working rather than failing on the next scheduled run.
 *
 * @return {string} 'oauth' or 'webhook'
 */
function getAuthMode_() {
  const raw = PropertiesService
    .getScriptProperties()
    .getProperty(AUTH_MODE_PROPERTY_KEY);

  const mode = String(raw || 'webhook').trim().toLowerCase();

  if (mode !== 'oauth' && mode !== 'webhook') {
    throw new Error(
      'Script property "' + AUTH_MODE_PROPERTY_KEY + '" must be ' +
      '"oauth" or "webhook" (found "' + mode + '").'
    );
  }

  return mode;
}

/**
 * Resolve the REST base URL and, in OAuth mode, a valid access
 * token. This is the only credential entry point used by
 * BitrixClient.
 *
 * @param {boolean=} forceRefresh OAuth only — mint a new access
 *     token even if the cached one looks current.
 * @return {{baseUrl: string, authToken: ?string}}
 */
function getAuthContext_(forceRefresh) {
  if (getAuthMode_() === 'oauth') {
    return getOAuthContext_(forceRefresh);
  }

  // Webhook mode: the token is embedded in the URL itself.
  return { baseUrl: getWebhookUrl_(), authToken: null };
}

/**
 * Retrieve and validate the webhook base URL.
 * Throws if missing or malformed — better a loud failure at
 * startup than a silent one mid-run.
 *
 * @return {string} Base URL with exactly one trailing slash.
 */
function getWebhookUrl_() {
  const raw = PropertiesService
    .getScriptProperties()
    .getProperty(WEBHOOK_PROPERTY_KEY);

  if (!raw) {
    throw new Error(
      'Webhook not configured. Add a Script Property named "' +
      WEBHOOK_PROPERTY_KEY + '". See Secrets.gs for instructions.'
    );
  }

  const url = String(raw).trim();

  // Shape check: https, a bitrix24 host, /rest/<user>/<token>/
  const SHAPE = /^https:\/\/[A-Za-z0-9.-]+\.bitrix24\.[A-Za-z.]+\/rest\/\d+\/[A-Za-z0-9]+\/?$/;

  if (!SHAPE.test(url)) {
    throw new Error(
      'Webhook URL is malformed. Expected the form ' +
      'https://<company>.bitrix24.<tld>/rest/<userId>/<token>/ ' +
      '(value not echoed here for security).'
    );
  }

  return url.replace(/\/+$/, '') + '/';
}

/**
 * Build a full REST method URL from a resolved base.
 *
 * @param {string} baseUrl From getAuthContext_(); has a trailing slash.
 * @param {string} method e.g. 'crm.deal.add'
 * @return {string}
 */
function buildMethodUrl_(baseUrl, method) {
  if (!/^[a-z][a-z0-9._]*$/i.test(method)) {
    throw new Error('Invalid Bitrix method name.');
  }
  return baseUrl + method + '.json';
}

/**
 * Strip every credential shape out of text before it is logged
 * or emailed. Bitrix echoes the request URL and sometimes the
 * request body in error payloads, either of which would
 * otherwise leak a live credential into the execution log —
 * which is readable by anyone who can open the script.
 *
 * Covers, in order: webhook URLs, OAuth tokens appearing as
 * query parameters, and tokens appearing as JSON values.
 *
 * @param {*} text
 * @return {string}
 */
function redactSecrets_(text) {
  return String(text == null ? '' : text)
    // Inbound webhook URL, e.g. .../rest/12345/abc123
    .replace(
      /https:\/\/[A-Za-z0-9.-]+\.bitrix24\.[A-Za-z.]+\/rest\/\d+\/[A-Za-z0-9]+/g,
      '[webhook redacted]'
    )
    // Query-string form: ?auth=xxx, &refresh_token=xxx
    .replace(
      /\b(auth|access_token|refresh_token|client_secret)=[^&\s"'}]+/gi,
      '$1=[redacted]'
    )
    // JSON form: "access_token":"xxx"
    .replace(
      /("(?:auth|access_token|refresh_token|client_secret)"\s*:\s*")[^"]*"/gi,
      '$1[redacted]"'
    );
}

/**
 * OPTIONAL one-time setter. Paste, run once, then clear the
 * value and save. Prefer the Project Settings UI instead.
 */
function setWebhookUrl_() {
  const url = '';  // <-- paste here, run, then blank it out again

  if (!url) {
    throw new Error(
      'Nothing to set. Either paste a URL here temporarily, or ' +
      'use Project Settings > Script Properties (preferred).'
    );
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(WEBHOOK_PROPERTY_KEY, url.trim());

  Logger.log('Webhook stored. Now clear the value above and save.');
}

// Connectivity testing lives in OAuth.gs as testBitrixConnection(),
// which exercises whichever mode is active through the real
// client — retry, throttling and redaction included.
