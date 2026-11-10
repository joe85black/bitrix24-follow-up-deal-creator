/**
 * ============================================================
 * DATEUTILS.GS — calendar arithmetic
 * ============================================================
 *
 * Every date in this project is treated as a CALENDAR date with
 * no time component. Time-of-day and timezone offsets are the
 * usual source of off-by-one-day bugs in this kind of script,
 * so they are stripped as early as possible.
 * ============================================================
 */

/**
 * @param {*} value
 * @return {boolean} True if a usable Date object.
 */
function isValidDate_(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

/**
 * Strip the time component, returning midnight local.
 *
 * @param {!Date} date
 * @return {!Date}
 */
function normalizeDate_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Coerce a spreadsheet cell into a calendar date.
 *
 * Handles real Date objects (the normal case when a cell is
 * formatted as a date) and a few common text formats, because
 * one text-formatted cell in thousands of rows should not silently
 * drop a client.
 *
 * @param {*} value
 * @return {?Date} null if unparseable.
 */
function parseCellDate_(value) {
  if (isValidDate_(value)) {
    return normalizeDate_(value);
  }

  if (typeof value === 'number' && value > 0) {
    // Google Sheets serial number (days since 1899-12-30).
    const ms = (value - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return isValidDate_(d)
      ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  if (!text) return null;

  // ISO: YYYY-MM-DD
  let m = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) {
    return buildDate_(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  // US: MM-DD-YYYY or MM/DD/YYYY
  m = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) {
    return buildDate_(Number(m[3]), Number(m[1]), Number(m[2]));
  }

  return null;
}

/**
 * Build a Date, rejecting impossible calendar dates such as
 * 2026-02-30 (which JavaScript would silently roll forward).
 *
 * @param {number} year
 * @param {number} month 1-based
 * @param {number} day
 * @return {?Date}
 */
function buildDate_(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day);

  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

/**
 * Compare two dates by calendar day.
 *
 * @param {!Date} a
 * @param {!Date} b
 * @return {number} negative if a < b, 0 if equal, positive if a > b.
 */
function compareDates_(a, b) {
  return normalizeDate_(a).getTime() - normalizeDate_(b).getTime();
}

/**
 * Add (or subtract) months, clamping to the last valid day of
 * the target month.
 *
 * The naive setMonth() approach overflows: Nov 30 minus 3 months
 * asks for "Aug 30" — fine — but Mar 31 minus 1 month asks for
 * "Feb 31", which JavaScript rolls forward to Mar 2 or 3. That
 * silently shifts trigger dates. Clamping gives Feb 28/29.
 *
 * @param {!Date} date
 * @param {number} months May be negative.
 * @return {!Date}
 */
function addMonths_(date, months) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  const targetMonthStart = new Date(year, month + months, 1);

  const lastDayOfTargetMonth = new Date(
    targetMonthStart.getFullYear(),
    targetMonthStart.getMonth() + 1,
    0
  ).getDate();

  return new Date(
    targetMonthStart.getFullYear(),
    targetMonthStart.getMonth(),
    Math.min(day, lastDayOfTargetMonth)
  );
}

/**
 * Format for the Bitrix API (and for logs).
 *
 * @param {?Date} date
 * @param {string} timezone
 * @return {string} '' when there is no date.
 */
function formatBitrixDate_(date, timezone) {
  if (!isValidDate_(date)) return '';
  return Utilities.formatDate(date, timezone, 'yyyy-MM-dd');
}

/**
 * Parse a 'YYYY-MM-DD' configuration value into a calendar date.
 *
 * Used for CONFIG.CUTOFF_DATE and for a scoped run's optional
 * window bounds (see runFollowUp_'s windowStart/windowEnd), so a
 * malformed date fails loudly at the start of a run rather than
 * silently shifting which rows qualify.
 *
 * @param {*} text
 * @param {string} label Name to quote in the error message.
 * @return {!Date}
 */
function parseIsoConfigDate_(text, label) {
  const m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!m) {
    throw new Error(label + ' must be in YYYY-MM-DD format.');
  }

  const d = buildDate_(Number(m[1]), Number(m[2]), Number(m[3]));

  if (!d) {
    throw new Error(label + ' is not a real calendar date.');
  }

  return d;
}

/**
 * Parse the configured cutoff date.
 *
 * @return {!Date}
 */
function getCutoffDate_() {
  return parseIsoConfigDate_(CONFIG.CUTOFF_DATE, 'CONFIG.CUTOFF_DATE');
}
