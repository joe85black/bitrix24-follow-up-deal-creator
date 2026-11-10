/**
 * ============================================================
 * CONFIG.GS — Bitrix24 Follow-Up Deal Creator
 * ============================================================
 *
 * All tunable settings live here. You should not need to edit
 * any other file for routine changes.
 *
 * The webhook URL is deliberately NOT in this file. It lives in
 * Script Properties. See Secrets.gs.
 * ============================================================
 */

const CONFIG = Object.freeze({

  /**
   * ----------------------------------------------------------
   * CUTOFF DATE  ***  READ THIS BEFORE GOING LIVE  ***
   * ----------------------------------------------------------
   *
   * Format: 'YYYY-MM-DD'
   *
   * No deal is EVER created for a row whose due date falls
   * before this date. This stops the first run from importing
   * years of historical follow-ups.
   *
   * Set this to the day you enable the daily trigger.
   */
  CUTOFF_DATE: '2020-01-01',

  /**
   * ----------------------------------------------------------
   * BITRIX24 TARGET
   * ----------------------------------------------------------
   */
  PIPELINE_ID: 0,            // Replace with your pipeline's CATEGORY_ID
  ENTRY_STAGE_ID: 'C0:NEW',  // Replace with your pipeline's entry STAGE_ID
  ASSIGNED_BY_ID: 0,         // Replace with the Bitrix user ID deals should be assigned to

  /**
   * ----------------------------------------------------------
   * BITRIX24 FIELD IDs
   * ----------------------------------------------------------
   *
   * These are the legacy (UPPER_CASE) codes used by
   * crm.deal.add. Do NOT substitute the camelCase ufCrm_* names
   * returned by crm.item.fields — crm.deal.add silently ignores
   * them and you get a deal with blank dates and no error.
   */
  FIELDS: Object.freeze({
    FOLLOW_UP_TYPE:                'UF_CRM_REPLACE_ME_1',
    ELIGIBILITY_FLAG:              'UF_CRM_REPLACE_ME_2',
    QUICK_CHECK_APPROVAL_DATE:     'UF_CRM_REPLACE_ME_3',
    QUICK_CHECK_EXPIRATION_DATE:   'UF_CRM_REPLACE_ME_4',
    STARTER_APPROVAL_DATE:         'UF_CRM_REPLACE_ME_5',
    BUSINESS_PLUS_SUBMISSION_DATE: 'UF_CRM_REPLACE_ME_6',
    INITIAL_CONTACT_DATE:          'UF_CRM_REPLACE_ME_7'
  }),

  /**
   * ----------------------------------------------------------
   * ENUMERATION ITEM IDs
   * ----------------------------------------------------------
   *
   * Bitrix enumeration fields store the numeric item ID, not
   * the display text. If you edit these dropdowns in Bitrix,
   * re-run crm.item.fields.json?entityTypeId=2 and update here.
   */
  ENUMS: Object.freeze({
    FOLLOW_UP_TYPE: Object.freeze({
      BUSINESS_PLUS: 0,  // Replace with your item IDs
      QUICK_CHECK:   0,
      ANNUAL_REVIEW: 0
    }),
    ELIGIBILITY_FLAG: Object.freeze({
      YES:     0,  // Replace with your item IDs
      NO:      0,
      UNKNOWN: 0
    })
  }),

  /**
   * ----------------------------------------------------------
   * SHEET DEFINITIONS
   * ----------------------------------------------------------
   *
   * Columns are 1-based (A = 1, B = 2, ...).
   *
   * expectedHeaders: text expected in row 1 of each mapped
   *   column, matched case-insensitively as a substring. Leave
   *   a value as '' to skip checking that one column.
   *   If a header does not match, that tab is SKIPPED and
   *   reported — this is the guard against someone inserting a
   *   column and silently shifting every field by one.
   *
   *   The match is a substring test, so an accented header (or
   *   any header in another language) still matches as long as
   *   the expected text is an ASCII substring of it.
   *
   * monthOffset: how many months BEFORE the trigger date the
   *   deal should be created. 3 = fire three months early.
   */
  SHEETS: Object.freeze({

    // Column B here is deliberately unused by the script — an
    // example of an unrelated column living between the mapped
    // ones. Config.gs's column indices don't need to be
    // contiguous; update them to match whatever layout your own
    // sheet actually uses.
    QUICK_CHECK: Object.freeze({
      key:         'QUICK_CHECK',
      name:        'Quick Check Updated',
      dealSuffix:  'Quick Check',
      nameCol:     1,  // A
      dealIdCol:   5,  // E
      triggerCol:  4,  // D — Expiration Date
      monthOffset: 3,
      dateCols:    Object.freeze({ approval: 3, expiration: 4 }), // C, D
      expectedHeaders: Object.freeze({
        1: 'name',
        2: '',           // an extra column of your own, unrelated to this script
        3: 'approval',
        4: 'expiration',
        5: ''  // fill in once you have named the Deal ID column
      })
    }),

    BUSINESS_PLUS: Object.freeze({
      key:         'BUSINESS_PLUS',
      name:        'Business Plus Updated',
      dealSuffix:  'Business Plus',
      nameCol:     1,  // A
      dealIdCol:   6,  // F
      triggerCol:  3,  // C — Enter in Contact Date
      monthOffset: 0,
      dateCols:    Object.freeze({ starterApproval: 2, contact: 3 }), // B, C
      expectedHeaders: Object.freeze({
        1: 'name',
        2: 'approval',
        3: 'contact',
        6: ''
      })
    }),

    ANNUAL_REVIEW: Object.freeze({
      key:         'ANNUAL_REVIEW',
      name:        'Annual Review Updated',
      dealSuffix:  'Annual Review',
      nameCol:     1,  // A
      dealIdCol:   9,  // I
      triggerCol:  5,  // E — Enter in Contact Date
      monthOffset: 0,
      dateCols:    Object.freeze({
        starterApproval:        2,  // B
        businessPlusSubmission: 3,  // C
        contact:                5   // E
      }),
      eligibilityCol: 4,   // D
      expectedHeaders: Object.freeze({
        1: 'name',
        2: 'approval',
        3: 'submission',
        4: 'eligibility',
        5: 'contact',
        9: ''
      })
    })
  }),

  /**
   * ----------------------------------------------------------
   * EXECUTION LIMITS
   * ----------------------------------------------------------
   *
   * Apps Script kills a function at 6 minutes. Bitrix throttles
   * at roughly 2 requests/second. If a run hits MAX_DEALS_PER_RUN
   * it schedules a one-off continuation trigger and resumes.
   *
   * Because every created deal is recorded in the sheet
   * immediately, a continuation simply skips what is already
   * done — no cursor state to corrupt.
   */
  MAX_DEALS_PER_RUN:        120,
  MAX_RUNTIME_MS:           4.5 * 60 * 1000,
  CONTINUATION_DELAY_MS:    2 * 60 * 1000,
  REQUEST_INTERVAL_MS:      600,   // ~1.6 req/sec, under the limit
  MAX_RETRIES:              4,
  RETRY_BASE_DELAY_MS:      1000,
  LOCK_TIMEOUT_MS:          30 * 1000,

  /**
   * ----------------------------------------------------------
   * NOTIFICATIONS
   * ----------------------------------------------------------
   */
  ALERT_EMAIL:      'alerts@example.com',
  ALWAYS_EMAIL:     false,  // true = send a summary even on clean runs

  /**
   * ----------------------------------------------------------
   * PRIVACY
   * ----------------------------------------------------------
   *
   * Execution logs are visible to anyone who can open the
   * script. Leave this false so client names are not written
   * to them; rows are identified by number instead.
   */
  LOG_CLIENT_NAMES: false
});
