/**
 * ============================================================
 * FOLLOWUPENGINE.GS — the processing logic
 * ============================================================
 *
 * One generic driver handles all three follow-up types. The
 * differences between Quick Check, Business Plus and Annual
 * Review live entirely in Config.gs and in buildFields_() below.
 * ============================================================
 */

/**
 * Process one configured sheet.
 *
 * @param {!Spreadsheet} spreadsheet
 * @param {!Object} sheetConfig
 * @param {!Object} context {today, cutoff, timezone, dryRun, budget}
 * @return {!Object} Per-sheet report.
 */
function processSheet_(spreadsheet, sheetConfig, context) {
  const report = {
    sheet: sheetConfig.name,
    created: [],
    failures: [],
    skipped: 0,
    invalidDates: [],
    aborted: null,
    halted: false
  };

  let sheet;
  try {
    sheet = getSheet_(spreadsheet, sheetConfig);
  } catch (error) {
    report.aborted = error.message;
    return report;
  }

  const data = readSheet_(sheet, sheetConfig);

  // --- Layout check before touching any data ---
  const headerProblems = validateHeaders_(data.headerRow, sheetConfig);
  if (headerProblems.length) {
    report.aborted =
      'Header validation failed, tab skipped to avoid writing wrong data: ' +
      headerProblems.join('; ');
    return report;
  }

  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    const rowNumber = data.firstDataRow + i;

    // Stop cleanly if we are near either limit; a continuation
    // trigger will resume from wherever the sheet says we got to.
    if (context.budget.exhausted()) {
      report.halted = true;
      break;
    }

    const name = String(row[sheetConfig.nameCol - 1] || '').trim();
    if (!name) continue;

    if (isAlreadyProcessed_(row, sheetConfig)) {
      report.skipped++;
      continue;
    }

    // --- Is this row due? ---
    const triggerDate = parseCellDate_(row[sheetConfig.triggerCol - 1]);

    if (!triggerDate) {
      if (String(row[sheetConfig.triggerCol - 1] || '').trim()) {
        report.invalidDates.push(rowNumber);
      }
      continue;
    }

    // The date on which the deal should be created.
    const dueDate = sheetConfig.monthOffset
      ? addMonths_(triggerDate, -sheetConfig.monthOffset)
      : triggerDate;

    // Not yet due.
    if (compareDates_(dueDate, context.today) > 0) continue;

    // Due, but before we went live — historical, ignore forever.
    if (compareDates_(dueDate, context.cutoff) < 0) continue;

    // --- Build and send ---
    const title = name + ' - ' + sheetConfig.dealSuffix;
    const fields = buildFields_(row, sheetConfig, context.timezone);

    if (context.dryRun) {
      report.created.push({
        row: rowNumber,
        title: title,
        dealId: '(dry run)',
        due: formatBitrixDate_(dueDate, context.timezone)
      });
      context.budget.spend();
      continue;
    }

    try {
      const dealId = createDeal_(title, fields);
      recordDealId_(sheet, rowNumber, dealId, sheetConfig);

      report.created.push({
        row: rowNumber,
        title: CONFIG.LOG_CLIENT_NAMES ? title : sheetConfig.dealSuffix,
        dealId: dealId,
        due: formatBitrixDate_(dueDate, context.timezone)
      });
    } catch (error) {
      // One bad row must not stop the rest.
      report.failures.push({
        row: rowNumber,
        error: redactSecrets_(error.message)
      });
    }

    context.budget.spend();
  }

  return report;
}

/**
 * Map a spreadsheet row onto Bitrix custom fields.
 *
 * This is the only place that knows which sheet column feeds
 * which Bitrix field.
 *
 * @param {!Array<*>} row
 * @param {!Object} sheetConfig
 * @param {string} timezone
 * @return {!Object<string, *>}
 */
function buildFields_(row, sheetConfig, timezone) {
  const F = CONFIG.FIELDS;
  const fields = {};

  const dateAt = function (column) {
    return formatBitrixDate_(parseCellDate_(row[column - 1]), timezone);
  };

  switch (sheetConfig.key) {

    case 'QUICK_CHECK':
      fields[F.FOLLOW_UP_TYPE]              = CONFIG.ENUMS.FOLLOW_UP_TYPE.QUICK_CHECK;
      fields[F.QUICK_CHECK_APPROVAL_DATE]   = dateAt(sheetConfig.dateCols.approval);
      fields[F.QUICK_CHECK_EXPIRATION_DATE] = dateAt(sheetConfig.dateCols.expiration);
      break;

    case 'BUSINESS_PLUS':
      fields[F.FOLLOW_UP_TYPE]        = CONFIG.ENUMS.FOLLOW_UP_TYPE.BUSINESS_PLUS;
      fields[F.STARTER_APPROVAL_DATE] = dateAt(sheetConfig.dateCols.starterApproval);
      fields[F.INITIAL_CONTACT_DATE]  = dateAt(sheetConfig.dateCols.contact);
      break;

    case 'ANNUAL_REVIEW':
      fields[F.FOLLOW_UP_TYPE]                = CONFIG.ENUMS.FOLLOW_UP_TYPE.ANNUAL_REVIEW;
      fields[F.STARTER_APPROVAL_DATE]         = dateAt(sheetConfig.dateCols.starterApproval);
      fields[F.BUSINESS_PLUS_SUBMISSION_DATE] = dateAt(sheetConfig.dateCols.businessPlusSubmission);
      fields[F.INITIAL_CONTACT_DATE]          = dateAt(sheetConfig.dateCols.contact);
      fields[F.ELIGIBILITY_FLAG]              = mapEligibilityFlag_(row[sheetConfig.eligibilityCol - 1]);
      break;

    default:
      throw new Error('Unknown sheet key: ' + sheetConfig.key);
  }

  // Bitrix rejects some field types when sent as empty strings.
  // Dropping empties leaves the field blank on the deal, which
  // is what an empty spreadsheet cell means anyway.
  Object.keys(fields).forEach(function (key) {
    if (fields[key] === '' || fields[key] === null || fields[key] === undefined) {
      delete fields[key];
    }
  });

  return fields;
}

/**
 * Map the Eligibility Flag column onto its enumeration item ID.
 *
 * Anything unrecognised — including an empty cell, which is the
 * common case — becomes "Unknown" rather than being guessed at.
 * Accepts several common spellings and real booleans, since the
 * column has been filled in by hand over time.
 *
 * @param {*} value
 * @return {number}
 */
function mapEligibilityFlag_(value) {
  const D = CONFIG.ENUMS.ELIGIBILITY_FLAG;

  if (value === true) return D.YES;
  if (value === false) return D.NO;

  const text = String(value == null ? '' : value).trim().toLowerCase();

  if (!text) return D.UNKNOWN;

  if (['yes', 'y', 'true', '1', 'eligible']
      .indexOf(text) !== -1) {
    return D.YES;
  }

  if (['no', 'n', 'false', '0', 'not eligible']
      .indexOf(text) !== -1) {
    return D.NO;
  }

  return D.UNKNOWN;
}

/**
 * Tracks how much of this execution's budget is left.
 *
 * Apps Script terminates a function at 6 minutes with no chance
 * to clean up, so we stop voluntarily before that and let a
 * continuation trigger pick up the rest.
 *
 * @param {number} startedAt
 * @return {{spend: !Function, exhausted: !Function, count: !Function}}
 */
function createBudget_(startedAt) {
  let dealsCreated = 0;

  return {
    spend: function () {
      dealsCreated++;
    },
    exhausted: function () {
      if (dealsCreated >= CONFIG.MAX_DEALS_PER_RUN) return true;
      return (Date.now() - startedAt) >= CONFIG.MAX_RUNTIME_MS;
    },
    count: function () {
      return dealsCreated;
    }
  };
}
