/**
 * ============================================================
 * BITRIXCLIENT.GS — the only file that talks to Bitrix24
 * ============================================================
 *
 * Responsibilities:
 *   - throttle to stay under Bitrix's ~2 req/sec limit
 *   - retry transient failures with exponential backoff
 *   - refresh an expired OAuth token and retry, once
 *   - never leak a credential into logs
 *   - convert everything into either a deal ID or a thrown Error
 *
 * It does not know or care whether the credential is an OAuth
 * access token or a webhook URL — getAuthContext_() decides.
 * ============================================================
 */

/** Timestamp of the last request, for throttling. */
let LAST_REQUEST_AT_ = 0;

/**
 * Sleep just long enough to respect REQUEST_INTERVAL_MS.
 */
function throttle_() {
  const elapsed = Date.now() - LAST_REQUEST_AT_;
  const wait = CONFIG.REQUEST_INTERVAL_MS - elapsed;
  if (wait > 0) {
    Utilities.sleep(wait);
  }
  LAST_REQUEST_AT_ = Date.now();
}

/**
 * Decide whether a failure is worth retrying.
 * Transient: rate limiting, gateway errors, network blips.
 * Permanent: bad field, bad token, malformed payload — retrying
 * those just wastes the run's time budget.
 *
 * @param {number} httpCode
 * @param {string} bitrixError
 * @return {boolean}
 */
function isRetryable_(httpCode, bitrixError) {
  if (httpCode === 429) return true;
  if (httpCode >= 500 && httpCode < 600) return true;
  if (httpCode === 0) return true; // network failure
  return String(bitrixError || '').toUpperCase() === 'QUERY_LIMIT_EXCEEDED';
}

/**
 * Has the access token gone stale?
 *
 * Deliberately NOT folded into isRetryable_. A plain retry
 * re-sends the same dead token and fails identically; this
 * condition is only recoverable by minting a new token first.
 *
 * @param {string} bitrixError
 * @return {boolean}
 */
function isAuthExpired_(bitrixError) {
  const code = String(bitrixError || '').toLowerCase();
  return code === 'expired_token' || code === 'invalid_token';
}

/**
 * Call a Bitrix REST method with retry and backoff.
 *
 * @param {string} method  e.g. 'crm.deal.add'
 * @param {!Object} payload
 * @return {*} The `result` value from Bitrix.
 * @throws {Error} On permanent failure or exhausted retries.
 */
function bitrixCall_(method, payload) {
  // Resolved once, but replaced in place if the token expires
  // partway through a long run.
  let ctx = getAuthContext_();

  // At most one forced refresh per call, so a permanently bad
  // credential cannot spin the loop.
  let reauthDone = false;

  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    throttle_();

    const url = buildMethodUrl_(ctx.baseUrl, method);

    // In OAuth mode the token travels in the body rather than
    // the URL, so it stays out of any request-URL echo.
    const body = ctx.authToken
      ? Object.assign({}, payload, { auth: ctx.authToken })
      : payload;

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
      followRedirects: false,
      validateHttpsCertificates: true
    };

    let httpCode = 0;
    let bodyText = '';

    try {
      const response = UrlFetchApp.fetch(url, options);
      httpCode = response.getResponseCode();
      bodyText = response.getContentText();
    } catch (networkError) {
      // Fetch itself failed — DNS, TLS, timeout.
      httpCode = 0;
      bodyText = String(networkError && networkError.message);
    }

    // --- Success path ---
    if (httpCode >= 200 && httpCode < 300) {
      let parsed;
      try {
        parsed = JSON.parse(bodyText);
      } catch (parseError) {
        lastError = 'Bitrix returned a non-JSON response (HTTP ' + httpCode + ')';
        // A malformed 200 is odd but usually transient (proxy page).
        if (attempt < CONFIG.MAX_RETRIES) {
          backoff_(attempt);
          continue;
        }
        throw new Error(lastError);
      }

      if (parsed.error) {
        const detail = redactSecrets_(parsed.error_description || parsed.error);

        // Token died mid-run: mint a new one and repeat this
        // attempt. attempt-- keeps it from consuming a retry
        // slot; reauthDone guarantees it happens at most once.
        if (isAuthExpired_(parsed.error) && ctx.authToken && !reauthDone) {
          reauthDone = true;
          ctx = getAuthContext_(true);
          attempt--;
          continue;
        }

        if (isRetryable_(httpCode, parsed.error) && attempt < CONFIG.MAX_RETRIES) {
          lastError = 'Bitrix error: ' + detail;
          backoff_(attempt);
          continue;
        }
        throw new Error('Bitrix error [' + redactSecrets_(parsed.error) + ']: ' + detail);
      }

      return parsed.result;
    }

    // --- Failure path ---
    lastError = 'HTTP ' + httpCode + ': ' + redactSecrets_(bodyText).slice(0, 300);

    let bitrixErrorCode = '';
    try {
      bitrixErrorCode = JSON.parse(bodyText).error || '';
    } catch (ignored) {
      bitrixErrorCode = '';
    }

    // Bitrix answers an expired token with HTTP 401, so the
    // same recovery is needed on this path too.
    if (isAuthExpired_(bitrixErrorCode) && ctx.authToken && !reauthDone) {
      reauthDone = true;
      ctx = getAuthContext_(true);
      attempt--;
      continue;
    }

    if (!isRetryable_(httpCode, bitrixErrorCode) || attempt === CONFIG.MAX_RETRIES) {
      throw new Error(lastError);
    }

    backoff_(attempt);
  }

  throw new Error('Exhausted retries. Last error: ' + lastError);
}

/**
 * Exponential backoff with jitter, so parallel retries do not
 * synchronise into a thundering herd.
 *
 * @param {number} attempt 1-based
 */
function backoff_(attempt) {
  const base = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 400);
  Utilities.sleep(base + jitter);
}

/**
 * Create a deal in the Follow-Up pipeline.
 *
 * @param {string} title Deal name, e.g. "Jane Doe - Business Plus".
 * @param {!Object<string, *>} customFields Map of UF_CRM_* -> value.
 * @return {number} The new Bitrix deal ID.
 */
function createDeal_(title, customFields) {
  const fields = Object.assign({
    TITLE:           title,
    CATEGORY_ID:     CONFIG.PIPELINE_ID,
    STAGE_ID:        CONFIG.ENTRY_STAGE_ID,
    ASSIGNED_BY_ID:  CONFIG.ASSIGNED_BY_ID,
    OPENED:          'Y'
  }, customFields);

  const result = bitrixCall_('crm.deal.add', {
    fields: fields,
    params: { REGISTER_SONET_EVENT: 'N' }  // skip activity stream noise
  });

  const dealId = Number(result);

  if (!dealId || isNaN(dealId)) {
    throw new Error('Bitrix accepted the request but returned no deal ID.');
  }

  return dealId;
}
