/**
 * ============================================================
 * OAUTH.GS — Bitrix24 local application credentials
 * ============================================================
 *
 * An alternative to the inbound webhook. Instead of one
 * permanent all-powerful URL, the script holds:
 *
 *   - an access token, valid ~1 hour, sent with every call
 *   - a refresh token, used to mint new access tokens
 *
 * Bitrix ROTATES the refresh token on every refresh: each
 * refresh returns a new one and invalidates the old. Storing
 * the new value is therefore not optional — dropping it breaks
 * the chain on the following run and forces a re-install.
 *
 * ------------------------------------------------------------
 * HOW THE TOKENS FIRST ARRIVE
 * ------------------------------------------------------------
 * Bitrix local apps have a built-in handshake. When you click
 * Install on the app, Bitrix POSTs to the app's handler URL
 * with AUTH_ID and REFRESH_ID already in the body. doPost()
 * below is that handler — there is no authorize redirect and
 * no code-for-token exchange to get wrong.
 *
 * Because that handler must be publicly reachable for Bitrix
 * to POST to it, it is protected three ways:
 *
 *   1. it refuses everything unless armInstall() was run in
 *      the last 15 minutes
 *   2. it refuses any payload whose DOMAIN is not the portal
 *      recorded in Script Properties
 *   3. it does nothing except write token properties — it
 *      never reads the Sheet and never creates a deal
 *
 * Set the deployment's access back to "Only myself" once
 * installed. Refreshes are outbound calls, so no inbound
 * endpoint is needed again until you re-authorise.
 *
 * ------------------------------------------------------------
 * ONE-TIME SETUP
 * ------------------------------------------------------------
 *  1. Deploy > New deployment > Web app
 *       Execute as: Me      Who has access: Anyone
 *     Copy the /exec URL.
 *
 *  2. Bitrix24 > Developer resources > Other >
 *     Local application:
 *       Handler path:  the /exec URL
 *       Scope:         crm
 *       Tick "uses only API"
 *     Save, then copy the application ID and key.
 *
 *  3. Project Settings > Script Properties, add:
 *       BITRIX_CLIENT_ID      the application ID (local.xxxxx)
 *       BITRIX_CLIENT_SECRET  the application key
 *       BITRIX_PORTAL_DOMAIN  YOUR_PORTAL.bitrix24.com
 *
 *  4. Run armInstall(), then click Install in Bitrix.
 *
 *  5. Set BITRIX_AUTH_MODE to "oauth".
 *
 *  6. Manage deployments > set access back to "Only myself".
 *
 * ------------------------------------------------------------
 * DORMANCY WARNING
 * ------------------------------------------------------------
 * A refresh token dies after roughly 30 days unused. The daily
 * trigger keeps it alive indefinitely. If the script sits
 * disabled for a month, repeat steps 1, 4 and 6.
 * ============================================================
 */

/** Script Property keys used by the OAuth path. */
const OAUTH_KEYS = Object.freeze({
  CLIENT_ID:       'BITRIX_CLIENT_ID',
  CLIENT_SECRET:   'BITRIX_CLIENT_SECRET',
  ACCESS_TOKEN:    'BITRIX_ACCESS_TOKEN',
  REFRESH_TOKEN:   'BITRIX_REFRESH_TOKEN',
  EXPIRES_AT:      'BITRIX_TOKEN_EXPIRES_AT',
  CLIENT_ENDPOINT: 'BITRIX_CLIENT_ENDPOINT',
  MEMBER_ID:       'BITRIX_MEMBER_ID',
  PORTAL_DOMAIN:   'BITRIX_PORTAL_DOMAIN',
  ARMED_UNTIL:     'BITRIX_INSTALL_ARMED_UNTIL'
});

/** Bitrix's cloud OAuth server. Same for every cloud portal. */
const OAUTH_TOKEN_ENDPOINT = 'https://oauth.bitrix.info/oauth/token/';

/** How long armInstall() leaves the handler open. */
const INSTALL_ARM_WINDOW_MS = 15 * 60 * 1000;

/** Refresh this far before actual expiry, so a long run cannot
 *  have a token die mid-batch. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Fallback lifetime if Bitrix omits one. Real value is 3600. */
const ASSUMED_TOKEN_LIFETIME_S = 3500;

/**
 * Open the install window. Run this immediately before clicking
 * Install in Bitrix; it expires on its own after 15 minutes.
 */
function armInstall() {
  const props = PropertiesService.getScriptProperties();

  // Fail now, not during the handshake, if setup is incomplete.
  requireProperty_(props, OAUTH_KEYS.CLIENT_ID);
  requireProperty_(props, OAUTH_KEYS.CLIENT_SECRET);

  const domain = normalizeDomain_(
    requireProperty_(props, OAUTH_KEYS.PORTAL_DOMAIN)
  );

  if (!domain) {
    throw new Error(
      'Script Property "' + OAUTH_KEYS.PORTAL_DOMAIN + '" does not contain ' +
      'a usable host. Expected something like YOUR_PORTAL.bitrix24.com'
    );
  }

  props.setProperty(OAUTH_KEYS.ARMED_UNTIL, String(Date.now() + INSTALL_ARM_WINDOW_MS));

  let handlerUrl = '(deploy as a web app to see the handler URL)';
  try {
    handlerUrl = ScriptApp.getService().getUrl() || handlerUrl;
  } catch (ignored) {
    // Not deployed yet — not fatal, the message below still helps.
  }

  Logger.log(
    'Install window open for %s minutes.\n' +
    'Portal:  %s\n' +
    'Handler: %s\n' +
    'Now click Install on the local application in Bitrix.',
    Math.round(INSTALL_ARM_WINDOW_MS / 60000), domain, handlerUrl
  );
}

/**
 * Close the install window early. Safe to run any time.
 */
function disarmInstall() {
  PropertiesService.getScriptProperties().deleteProperty(OAUTH_KEYS.ARMED_UNTIL);
  Logger.log('Install window closed.');
}

/**
 * Bitrix install handler. Bitrix POSTs here when the local
 * application is installed.
 *
 * Deliberately minimal: it writes token properties and nothing
 * else. Do not add Sheet access or deal creation to this
 * function — it is reachable by anyone while the deployment is
 * set to "Anyone".
 *
 * @param {!Object} e Apps Script web app event.
 * @return {!Object} Text or HTML output.
 */
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();

    // Guard 1: must be armed.
    const armedUntil = Number(props.getProperty(OAUTH_KEYS.ARMED_UNTIL) || 0);
    if (!armedUntil || Date.now() > armedUntil) {
      return installRefused_('not armed');
    }

    const params = (e && e.parameter) || {};

    // Guard 2: must actually carry credentials, in whichever of
    // the two shapes this app type produces.
    const creds = extractInstallCredentials_(params);

    if (!creds) {
      // Log the key NAMES only — never the values, which are the
      // credentials themselves. Enough to diagnose a new payload
      // shape without writing a token to the log.
      return installRefused_(
        'no credentials in payload; keys received: ' +
        Object.keys(params).sort().join(', ')
      );
    }

    // Guard 3: must be our portal.
    const expected = normalizeDomain_(props.getProperty(OAUTH_KEYS.PORTAL_DOMAIN));

    if (!expected || creds.domain !== expected) {
      return installRefused_(
        'unexpected domain "' + creds.domain + '", expected "' + expected + '"'
      );
    }

    props.setProperties({
      [OAUTH_KEYS.ACCESS_TOKEN]:    creds.accessToken,
      [OAUTH_KEYS.REFRESH_TOKEN]:   creds.refreshToken,
      [OAUTH_KEYS.EXPIRES_AT]:      String(Date.now() + creds.lifetime * 1000),
      [OAUTH_KEYS.CLIENT_ENDPOINT]: 'https://' + creds.domain + '/rest/',
      [OAUTH_KEYS.MEMBER_ID]:       creds.memberId
    }, false);

    // One-shot: a second POST must be armed again.
    props.deleteProperty(OAUTH_KEYS.ARMED_UNTIL);

    console.log('Install handshake accepted for ' + creds.domain + '. Tokens stored.');

    return HtmlService.createHtmlOutput(
      '<p>Installed. You can close this window.</p>'
    );

  } catch (error) {
    // Never echo the error to the caller — it could describe
    // internal state to someone who should not see it.
    console.log('Install handler error: ' + redactSecrets_(error && error.message));
    return installRefused_('handler error');
  }
}

/**
 * Pull the token pair out of an install payload.
 *
 * Bitrix uses two different shapes depending on how the local
 * application is configured, and which one you get is not
 * obvious from the setup form:
 *
 *   A. Interactive install (app WITH a user interface). Bitrix
 *      opens the handler in an iframe and POSTs flat keys:
 *        AUTH_ID, REFRESH_ID, AUTH_EXPIRES, DOMAIN, member_id
 *
 *   B. ONAPPINSTALL event ("Script only" apps). Bitrix POSTs
 *      PHP-style nested parameters:
 *        auth[access_token], auth[refresh_token],
 *        auth[expires_in], auth[domain], auth[member_id]
 *      Apps Script does not parse those into a nested object —
 *      they arrive as literal keys with brackets in the name.
 *
 * Accepting both means the app installs either way, so the
 * "Script only" checkbox becomes a cosmetic choice rather than
 * a functional one.
 *
 * @param {!Object<string,string>} params
 * @return {?{accessToken: string, refreshToken: string,
 *            domain: string, memberId: string, lifetime: number}}
 */
function extractInstallCredentials_(params) {
  // Shape A — interactive install.
  if (params.AUTH_ID && params.REFRESH_ID) {
    return {
      accessToken:  String(params.AUTH_ID).trim(),
      refreshToken: String(params.REFRESH_ID).trim(),
      domain:       normalizeDomain_(params.DOMAIN),
      memberId:     String(params.member_id || ''),
      lifetime:     Number(params.AUTH_EXPIRES) || ASSUMED_TOKEN_LIFETIME_S
    };
  }

  // Shape B — ONAPPINSTALL event.
  const accessToken = params['auth[access_token]'];
  const refreshToken = params['auth[refresh_token]'];

  if (accessToken && refreshToken) {
    return {
      accessToken:  String(accessToken).trim(),
      refreshToken: String(refreshToken).trim(),
      // DOMAIN is sometimes present alongside the nested keys.
      domain:       normalizeDomain_(params['auth[domain]'] || params.DOMAIN),
      memberId:     String(params['auth[member_id]'] || params.member_id || ''),
      lifetime:     Number(params['auth[expires_in]']) || ASSUMED_TOKEN_LIFETIME_S
    };
  }

  return null;
}

/**
 * Uniform refusal. Logs the reason for you; tells the caller
 * nothing.
 *
 * console.log rather than Logger.log: Logger output is often
 * not retained for anonymous web app executions, which is
 * exactly when you need to read it.
 *
 * @param {string} reason
 * @return {!Object}
 */
function installRefused_(reason) {
  console.log('Install POST refused: ' + reason);
  return ContentService
    .createTextOutput('Forbidden')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Resolve the OAuth base URL and a usable access token.
 *
 * @param {boolean=} forceRefresh Skip the cache; mint a new token.
 * @return {{baseUrl: string, authToken: string}}
 */
function getOAuthContext_(forceRefresh) {
  const endpoint = PropertiesService
    .getScriptProperties()
    .getProperty(OAUTH_KEYS.CLIENT_ENDPOINT);

  if (!endpoint) {
    throw new Error(
      'Bitrix OAuth is not set up. Run armInstall() and install the ' +
      'local application in Bitrix. See OAuth.gs for the full sequence.'
    );
  }

  return {
    baseUrl: endpoint.replace(/\/+$/, '') + '/',
    authToken: freshAccessToken_(forceRefresh)
  };
}

/**
 * Return a valid access token, refreshing only when needed.
 *
 * @param {boolean=} forceRefresh
 * @return {string}
 */
function freshAccessToken_(forceRefresh) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(OAUTH_KEYS.ACCESS_TOKEN);
  const expiresAt = Number(props.getProperty(OAUTH_KEYS.EXPIRES_AT) || 0);

  if (!forceRefresh && token && Date.now() < expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
    return token;
  }

  return refreshAccessToken_();
}

/**
 * Exchange the refresh token for a new token pair.
 *
 * CONCURRENCY: the refresh token is single-use. Two executions
 * refreshing at once would leave one holding a dead token and
 * needing a re-install. runFollowUp_ already holds the script
 * lock for its whole run, so scheduled and continuation runs
 * cannot overlap. This takes the lock only when that run-level
 * lock is NOT already held (i.e. a manually run test function),
 * because re-acquiring it inside a run would deadlock.
 *
 * @return {string} The new access token.
 */
function refreshAccessToken_() {
  const lock = SCRIPT_LOCK_HELD_ ? null : LockService.getScriptLock();

  if (lock && !lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error(
      'Could not acquire the lock to refresh the Bitrix token — ' +
      'another run is in progress. Try again shortly.'
    );
  }

  try {
    const props = PropertiesService.getScriptProperties();

    // Someone may have refreshed while we waited for the lock.
    const existing = props.getProperty(OAUTH_KEYS.ACCESS_TOKEN);
    const expiresAt = Number(props.getProperty(OAUTH_KEYS.EXPIRES_AT) || 0);

    if (existing && Date.now() < expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      return existing;
    }

    const response = UrlFetchApp.fetch(OAUTH_TOKEN_ENDPOINT, {
      method: 'post',
      payload: {
        grant_type:    'refresh_token',
        client_id:     requireProperty_(props, OAUTH_KEYS.CLIENT_ID),
        client_secret: requireProperty_(props, OAUTH_KEYS.CLIENT_SECRET),
        refresh_token: requireProperty_(props, OAUTH_KEYS.REFRESH_TOKEN)
      },
      muteHttpExceptions: true,
      validateHttpsCertificates: true
    });

    const bodyText = response.getContentText();
    let parsed;

    try {
      parsed = JSON.parse(bodyText);
    } catch (parseError) {
      throw new Error(
        'Bitrix OAuth server returned a non-JSON response (HTTP ' +
        response.getResponseCode() + ').'
      );
    }

    if (parsed.error || !parsed.access_token) {
      throw new Error(
        'Token refresh failed [' + redactSecrets_(parsed.error || 'no token returned') + ']: ' +
        redactSecrets_(parsed.error_description || '') +
        ' — re-authorise: deploy the web app with "Anyone" access, run ' +
        'armInstall(), then click Install in Bitrix.'
      );
    }

    const lifetime = Number(parsed.expires_in) || ASSUMED_TOKEN_LIFETIME_S;

    const updates = {
      [OAUTH_KEYS.ACCESS_TOKEN]: parsed.access_token,
      [OAUTH_KEYS.EXPIRES_AT]:   String(Date.now() + lifetime * 1000)
    };

    // Bitrix rotates the refresh token. Losing this write is
    // what turns a working install into a dead one.
    if (parsed.refresh_token) {
      updates[OAUTH_KEYS.REFRESH_TOKEN] = parsed.refresh_token;
    }

    // Survives a portal rename without any manual intervention.
    if (parsed.client_endpoint) {
      updates[OAUTH_KEYS.CLIENT_ENDPOINT] = parsed.client_endpoint;
    }

    props.setProperties(updates, false);

    return parsed.access_token;

  } finally {
    if (lock) lock.releaseLock();
  }
}

/**
 * Reduce a portal address to the bare host Bitrix sends in the
 * install POST's DOMAIN parameter.
 *
 * Accepts what a person naturally pastes — a full URL copied
 * from the browser bar — and strips it down, because the domain
 * check is an exact comparison and a stray scheme or trailing
 * slash would silently reject a legitimate install.
 *
 *   https://YOUR_PORTAL.bitrix24.com/  ->  your_portal.bitrix24.com
 *
 * @param {*} value
 * @return {string}
 */
function normalizeDomain_(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')  // scheme
    .replace(/\/.*$/, '');        // path, query, trailing slash
}

/**
 * Read a required Script Property or throw a useful error.
 *
 * @param {!Properties} props
 * @param {string} key
 * @return {string}
 */
function requireProperty_(props, key) {
  const value = props.getProperty(key);

  if (!value || !String(value).trim()) {
    throw new Error(
      'Missing Script Property "' + key + '". ' +
      'Add it under Project Settings > Script Properties.'
    );
  }

  return String(value).trim();
}

/**
 * Verify the current credentials, whichever mode is active.
 * Safe to run any time — it only reads.
 *
 * Uses crm.deal.fields rather than user.current because the
 * local application is deliberately scoped to `crm` alone.
 * user.current requires the `user` scope, and widening the
 * app's permissions just to run a health check would be the
 * wrong trade.
 *
 * It also validates every configured custom field ID in the
 * same call. That catches the nastiest failure in this project:
 * a wrong or renamed UF_CRM_* code produces a deal with
 * silently blank dates and no error whatsoever.
 *
 * @return {{fieldCount: number, missing: !Array<string>}}
 */
function testBitrixConnection() {
  const fields = bitrixCall_('crm.deal.fields', {});

  if (!fields || typeof fields !== 'object') {
    throw new Error('crm.deal.fields returned nothing usable.');
  }

  const configured = Object.keys(CONFIG.FIELDS);
  const missing = [];

  configured.forEach(function (name) {
    const code = CONFIG.FIELDS[name];
    if (!fields[code]) {
      missing.push(name + ' -> ' + code);
    }
  });

  Logger.log(
    'Mode: %s. Connected to CRM: %s deal fields visible.',
    getAuthMode_(), Object.keys(fields).length
  );

  if (missing.length) {
    Logger.log(
      'WARNING: %s of %s configured custom fields do NOT exist on crm.deal:\n   %s\n' +
      'Deals would be created with these left blank and no error raised. ' +
      'Re-check the IDs with crm.item.fields.json?entityTypeId=2 and use the ' +
      'UPPER_CASE codes, not the camelCase ufCrm_* names.',
      missing.length, configured.length, missing.join('\n   ')
    );
  } else {
    Logger.log('All %s configured custom fields exist.', configured.length);
  }

  return {
    fieldCount: Object.keys(fields).length,
    missing: missing
  };
}

/**
 * Print the credential state without revealing any secret.
 * Useful when a run has failed and you need to know why.
 */
function showOAuthStatus() {
  const props = PropertiesService.getScriptProperties();

  const expiresAt = Number(props.getProperty(OAUTH_KEYS.EXPIRES_AT) || 0);
  const armedUntil = Number(props.getProperty(OAUTH_KEYS.ARMED_UNTIL) || 0);

  const present = function (key) {
    return props.getProperty(key) ? 'set' : 'MISSING';
  };

  Logger.log(
    'Auth mode:       %s\n' +
    'Portal domain:   %s\n' +
    'Client endpoint: %s\n' +
    'Client ID:       %s\n' +
    'Client secret:   %s\n' +
    'Access token:    %s\n' +
    'Refresh token:   %s\n' +
    'Token expires:   %s\n' +
    'Install window:  %s',
    getAuthMode_(),
    normalizeDomain_(props.getProperty(OAUTH_KEYS.PORTAL_DOMAIN)) || 'MISSING',
    props.getProperty(OAUTH_KEYS.CLIENT_ENDPOINT) || 'MISSING',
    present(OAUTH_KEYS.CLIENT_ID),
    present(OAUTH_KEYS.CLIENT_SECRET),
    present(OAUTH_KEYS.ACCESS_TOKEN),
    present(OAUTH_KEYS.REFRESH_TOKEN),
    expiresAt ? new Date(expiresAt).toISOString() : 'never issued',
    armedUntil > Date.now() ? 'OPEN until ' + new Date(armedUntil).toISOString() : 'closed'
  );
}
