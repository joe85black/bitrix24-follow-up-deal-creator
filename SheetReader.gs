/**
 * ============================================================
 * SHEETREADER.GS — all spreadsheet access
 * ============================================================
 *
 * Isolating sheet I/O here means the engine never touches the
 * Sheets API directly, and column layout changes are contained
 * to Config.gs plus this file.
 * ============================================================
 */

/**
 * Fetch a sheet by name, or throw a clear error.
 *
 * @param {!Spreadsheet} spreadsheet
 * @param {!Object} sheetConfig
 * @return {!Sheet}
 */
function getSheet_(spreadsheet, sheetConfig) {
  const sheet = spreadsheet.getSheetByName(sheetConfig.name);

  if (!sheet) {
    throw new Error('Sheet not found: "' + sheetConfig.name + '"');
  }
  return sheet;
}

/**
 * Verify row 1 headers still match expectations.
 *
 * This is the guard against someone inserting a column. Without
 * it, every mapped field shifts by one and the script writes
 * wrong data into Bitrix — confidently and silently.
 *
 * @param {!Array<*>} headerRow
 * @param {!Object} sheetConfig
 * @return {!Array<string>} Human-readable problems; empty if OK.
 */
function validateHeaders_(headerRow, sheetConfig) {
  const problems = [];
  const expected = sheetConfig.expectedHeaders || {};

  Object.keys(expected).forEach(function (colStr) {
    const expectedText = String(expected[colStr] || '').trim().toLowerCase();
    if (!expectedText) return;  // '' means "do not check"

    const colIndex = Number(colStr) - 1;
    const actual = String(headerRow[colIndex] == null ? '' : headerRow[colIndex])
      .trim()
      .toLowerCase();

    if (actual.indexOf(expectedText) === -1) {
      problems.push(
        'column ' + columnLetter_(Number(colStr)) +
        ' header is "' + (actual || '(empty)') +
        '", expected it to contain "' + expectedText + '"'
      );
    }
  });

  return problems;
}

/**
 * Convert a 1-based column number to its letter(s).
 *
 * @param {number} column
 * @return {string}
 */
function columnLetter_(column) {
  let letter = '';
  let n = column;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * Read every data row, including the Deal ID column even when
 * it sits beyond the populated range.
 *
 * getDataRange() only spans columns that contain data, so on a
 * fresh sheet the Deal ID column would be missing entirely.
 * An explicit range avoids that.
 *
 * @param {!Sheet} sheet
 * @param {!Object} sheetConfig
 * @return {{headerRow: !Array<*>, rows: !Array<!Array<*>>, firstDataRow: number}}
 */
function readSheet_(sheet, sheetConfig) {
  const lastRow = sheet.getLastRow();

  const widestColumn = Math.max(
    sheetConfig.dealIdCol,
    sheetConfig.nameCol,
    sheetConfig.triggerCol,
    sheetConfig.eligibilityCol || 0,
    Math.max.apply(null, Object.keys(sheetConfig.dateCols).map(function (k) {
      return sheetConfig.dateCols[k];
    }))
  );

  if (lastRow < 1) {
    return { headerRow: [], rows: [], firstDataRow: 2 };
  }

  const values = sheet.getRange(1, 1, lastRow, widestColumn).getValues();

  return {
    headerRow: values[0] || [],
    rows: values.slice(1),
    firstDataRow: 2
  };
}

/**
 * Record a created deal ID against its row.
 *
 * Written one row at a time and flushed immediately rather than
 * batched at the end. Batching would be faster, but if the
 * execution were killed mid-run the unwritten IDs would be lost
 * and the next run would create duplicate deals. Duplicate
 * client follow-ups are worse than a few extra milliseconds.
 *
 * @param {!Sheet} sheet
 * @param {number} rowNumber 1-based sheet row.
 * @param {number} dealId
 * @param {!Object} sheetConfig
 */
function recordDealId_(sheet, rowNumber, dealId, sheetConfig) {
  sheet.getRange(rowNumber, sheetConfig.dealIdCol).setValue(dealId);
  SpreadsheetApp.flush();
}

/**
 * Has this row already produced a deal?
 *
 * @param {!Array<*>} row
 * @param {!Object} sheetConfig
 * @return {boolean}
 */
function isAlreadyProcessed_(row, sheetConfig) {
  const value = row[sheetConfig.dealIdCol - 1];
  return value !== '' && value !== null && value !== undefined;
}

/**
 * Confirm the script and spreadsheet agree on a timezone.
 *
 * new Date() resolves in the script's timezone while date cells
 * come back in the spreadsheet's. If they differ, every date
 * comparison can be a day out.
 *
 * @param {!Spreadsheet} spreadsheet
 * @return {?string} A warning message, or null when they match.
 */
function checkTimezoneAlignment_(spreadsheet) {
  const sheetTz = spreadsheet.getSpreadsheetTimeZone();
  const scriptTz = Session.getScriptTimeZone();

  if (sheetTz === scriptTz) return null;

  return 'Timezone mismatch: spreadsheet is "' + sheetTz +
         '" but the script project is "' + scriptTz +
         '". Set the script timezone to match in Project Settings, ' +
         'or dates may be evaluated a day early or late.';
}
