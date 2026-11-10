/**
 * ============================================================
 * MAIN.GS — entry points
 * ============================================================
 *
 * Attach createFollowUpDeals to a daily time-driven trigger
 * using the Apps Script trigger UI (clock icon > Add Trigger).
 *
 * Run dryRunFollowUpDeals first to see what would happen
 * without creating anything in Bitrix.
 * ============================================================
 */

const CONTINUATION_HANDLER = 'continueFollowUpDeals';

/**
 * True while runFollowUp_ holds the script lock.
 *
 * refreshAccessToken_ reads this to decide whether it needs to
 * take the lock itself. Re-acquiring an already-held lock from
 * inside the same execution would risk deadlocking the run.
 */
let SCRIPT_LOCK_HELD_ = false;

/**
 * MAIN ENTRY POINT. Attach this to the daily trigger.
 */
function createFollowUpDeals() {
  runFollowUp_({ dryRun: false, isContinuation: false });
}

/**
 * Preview mode. Creates nothing, writes nothing, sends nothing
 * to Bitrix — just reports what a real run would do.
 *
 * Run this before going live, and after any config change.
 */
function dryRunFollowUpDeals() {
  // runFollowUp_ does the logging, in verbose mode for dry runs.
  return runFollowUp_({ dryRun: true, isContinuation: false });
}

/**
 * Invoked by a self-scheduled continuation trigger when a run
 * hits its budget. Not for manual use.
 */
function continueFollowUpDeals() {
  cleanUpContinuationTriggers_(CONTINUATION_HANDLER);
  runFollowUp_({ dryRun: false, isContinuation: true });
}

/**
 * Orchestrates a single execution.
 *
 * The optional fields support a scoped run — for example, a
 * one-off historical catch-up limited to a single sheet and a
 * specific date range, run manually from the script editor.
 * Omitting them all gives the normal daily run: every sheet,
 * from CONFIG.CUTOFF_DATE through today. See "Advanced: scoped
 * runs" in the README for a worked example.
 *
 * @param {{
 *   dryRun: boolean,
 *   isContinuation: boolean,
 *   sheetKeys: (!Array<string>|undefined),
 *   windowStart: (string|undefined),
 *   windowEnd: (string|undefined),
 *   continuationHandler: (string|undefined),
 *   alwaysNotify: (boolean|undefined),
 *   label: (string|undefined)
 * }} options
 * @return {!Object} The run report.
 */
function runFollowUp_(options) {
  const startedAt = Date.now();

  const sheetKeys = options.sheetKeys || ['QUICK_CHECK', 'BUSINESS_PLUS', 'ANNUAL_REVIEW'];

  const continuationHandler =
    options.continuationHandler || CONTINUATION_HANDLER;

  const report = {
    startedAt: new Date(),
    dryRun: options.dryRun,
    isContinuation: options.isContinuation,
    label: options.label || null,
    alwaysNotify: !!options.alwaysNotify,
    warnings: [],
    sheets: [],
    fatal: null,
    continuationScheduled: false
  };

  // A lock prevents an overlapping manual run and scheduled run
  // from both reading the same unmarked rows and each creating
  // a deal for them.
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    report.fatal = 'Another run is already in progress; this execution exited.';
    Logger.log(report.fatal);
    return report;
  }

  SCRIPT_LOCK_HELD_ = true;

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    if (!spreadsheet) {
      throw new Error(
        'No active spreadsheet. This script must be bound to the Sheet ' +
        '(opened via Extensions > Apps Script).'
      );
    }

    const timezone = spreadsheet.getSpreadsheetTimeZone();

    const timezoneWarning = checkTimezoneAlignment_(spreadsheet);
    if (timezoneWarning) report.warnings.push(timezoneWarning);

    // processSheet_ creates a deal when the due date falls in
    // [cutoff, today]. A normal run ends that window at today;
    // a scoped run can pin both ends to a historical range.
    const windowEnd = options.windowEnd
      ? parseIsoConfigDate_(options.windowEnd, 'windowEnd')
      : normalizeDate_(new Date());

    const windowStart = options.windowStart
      ? parseIsoConfigDate_(options.windowStart, 'windowStart')
      : getCutoffDate_();

    if (compareDates_(windowStart, windowEnd) > 0) {
      throw new Error(
        'Window start (' + formatBitrixDate_(windowStart, timezone) +
        ') is after window end (' + formatBitrixDate_(windowEnd, timezone) +
        '); no row could ever qualify.'
      );
    }

    const context = {
      today:    windowEnd,
      cutoff:   windowStart,
      timezone: timezone,
      dryRun:   options.dryRun,
      budget:   createBudget_(startedAt)
    };

    report.today  = formatBitrixDate_(context.today, timezone);
    report.cutoff = formatBitrixDate_(context.cutoff, timezone);

    // Fail fast on a missing credential or a dead refresh token
    // rather than discovering it on the first row.
    if (!options.dryRun) {
      getAuthContext_();
    }

    sheetKeys.forEach(function (key) {
      const sheetConfig = CONFIG.SHEETS[key];

      if (!sheetConfig) {
        throw new Error('Unknown sheet key requested: ' + key);
      }

      report.sheets.push(
        processSheet_(spreadsheet, sheetConfig, context)
      );
    });

    // If any sheet stopped early, schedule a resume. The handler
    // must be the one matching THIS run — resuming a scoped run
    // with the daily handler would silently drop the window and
    // process every sheet instead.
    const halted = report.sheets.some(function (s) { return s.halted; });

    if (halted && !options.dryRun) {
      scheduleContinuation_(continuationHandler);
      report.continuationScheduled = true;
    }

  } catch (error) {
    report.fatal = redactSecrets_(error.message);
  } finally {
    lock.releaseLock();
    SCRIPT_LOCK_HELD_ = false;
  }

  report.finishedAt = new Date();

  // Dry runs get the per-row detail; real runs stay terse, since
  // this same text is what gets emailed.
  const summary = formatReport_(report, options.dryRun);
  Logger.log(summary);

  if (!options.dryRun && shouldNotify_(report)) {
    sendAlert_(report, summary);
  }

  return report;
}

/**
 * Should this run generate an email?
 *
 * @param {!Object} report
 * @return {boolean}
 */
function shouldNotify_(report) {
  if (CONFIG.ALWAYS_EMAIL) return true;
  if (report.alwaysNotify) return true;
  if (report.fatal) return true;
  if (report.warnings.length) return true;

  return report.sheets.some(function (sheet) {
    return sheet.aborted ||
           sheet.failures.length > 0 ||
           sheet.invalidDates.length > 0;
  });
}

/**
 * Schedule a one-off continuation trigger.
 *
 * @param {string} handler Function name to resume with.
 */
function scheduleContinuation_(handler) {
  cleanUpContinuationTriggers_(handler);

  ScriptApp.newTrigger(handler)
    .timeBased()
    .after(CONFIG.CONTINUATION_DELAY_MS)
    .create();

  Logger.log('Budget reached. Continuation scheduled in %s minutes.',
    Math.round(CONFIG.CONTINUATION_DELAY_MS / 60000));
}

/**
 * Remove spent continuation triggers so they do not accumulate
 * against the project's trigger quota. Leaves the daily trigger
 * you created in the UI untouched.
 *
 * @param {string} handler Only triggers for this function are removed.
 */
function cleanUpContinuationTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/**
 * Render a run report as plain text.
 *
 * @param {!Object} report
 * @param {boolean} verbose Include per-row detail (dry runs).
 * @return {string}
 */
function formatReport_(report, verbose) {
  const lines = [];

  lines.push('==================================================');
  lines.push(report.dryRun ? 'DRY RUN — nothing was created' : 'Bitrix Follow-Up Deal run');
  if (report.label) lines.push(report.label);
  if (report.isContinuation) lines.push('(continuation of an earlier run)');

  if (report.label) {
    // A scoped run: both ends of the window are meaningful.
    lines.push('Due between: ' + (report.cutoff || '?') +
               ' and ' + (report.today || '?'));
  } else {
    lines.push('Today:  ' + (report.today || '?'));
    lines.push('Cutoff: ' + (report.cutoff || '?'));
  }
  lines.push('==================================================');

  if (report.fatal) {
    lines.push('');
    lines.push('FATAL: ' + report.fatal);
    lines.push('No further processing occurred.');
    return lines.join('\n');
  }

  report.warnings.forEach(function (warning) {
    lines.push('WARNING: ' + warning);
  });

  let totalCreated = 0;
  let totalFailed = 0;

  report.sheets.forEach(function (sheet) {
    lines.push('');
    lines.push('--- ' + sheet.sheet + ' ---');

    if (sheet.aborted) {
      lines.push('ABORTED: ' + sheet.aborted);
      return;
    }

    totalCreated += sheet.created.length;
    totalFailed += sheet.failures.length;

    lines.push('Created:            ' + sheet.created.length);
    lines.push('Already processed:  ' + sheet.skipped);

    if (sheet.failures.length) {
      lines.push('FAILED:             ' + sheet.failures.length);
      sheet.failures.forEach(function (failure) {
        lines.push('   row ' + failure.row + ': ' + failure.error);
      });
    }

    if (sheet.invalidDates.length) {
      lines.push('Unreadable dates in rows: ' + sheet.invalidDates.join(', '));
      lines.push('   (these rows were skipped and will be retried next run)');
    }

    if (sheet.halted) {
      lines.push('Stopped early on this tab — remaining rows resume shortly.');
    }

    if (verbose && sheet.created.length) {
      lines.push('Would create:');
      sheet.created.forEach(function (deal) {
        lines.push('   row ' + deal.row + ': "' + deal.title + '" (due ' + deal.due + ')');
      });
    }
  });

  lines.push('');
  lines.push('==================================================');
  lines.push('TOTAL created: ' + totalCreated + '   failed: ' + totalFailed);

  if (report.continuationScheduled) {
    lines.push('A continuation run has been scheduled.');
  }

  lines.push('==================================================');

  return lines.join('\n');
}

/**
 * Email the run summary.
 *
 * @param {!Object} report
 * @param {string} summary
 */
function sendAlert_(report, summary) {
  if (!CONFIG.ALERT_EMAIL) return;

  const failed = report.fatal ||
    report.sheets.some(function (s) {
      return s.aborted || s.failures.length > 0;
    });

  const subject = failed
    ? '[ACTION NEEDED] Bitrix follow-up sync problem'
    : '[FYI] Bitrix follow-up sync report';

  try {
    MailApp.sendEmail({
      to: CONFIG.ALERT_EMAIL,
      subject: subject,
      body: summary + '\n\nSpreadsheet: ' +
            SpreadsheetApp.getActiveSpreadsheet().getUrl()
    });
  } catch (error) {
    // Never let a mail failure mask the run's own result.
    Logger.log('Could not send alert email: ' + error.message);
  }
}
