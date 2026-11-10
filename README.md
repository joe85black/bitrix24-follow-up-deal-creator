# Bitrix24 Follow-Up Deal Creator

A Google Apps Script that reads three tabs of a Google Sheet and automatically creates deals in a Bitrix24 CRM pipeline when a client's follow-up date arrives. Built for tracking time-based client follow-ups (e.g. renewals, expirations, check-in windows), but the sheet/field mapping in `Config.gs` is easy to adapt to any three-tab, date-driven workflow.

All names and data in this repository are fictional examples.

**Highlights**

- Authenticates as a Bitrix24 local application (OAuth) rather than a permanent all-powerful webhook URL — with the webhook kept as a one-property rollback path.
- Self-healing: a missed daily run catches up automatically instead of dropping rows.
- Resumable: long runs stop cleanly before Apps Script's execution limit and continue via a self-scheduled trigger.
- Guarded: a header-layout check aborts a tab (and emails you) rather than writing data into the wrong fields if a column ever shifts.
- No secrets in source: credentials live in Script Properties, never in code or version history.
- Supports scoped, one-off runs (a single sheet, a specific historical date range) via `runFollowUp_`'s optional arguments — handy for a backfill without touching the daily trigger.

## Files

| File | Purpose |
|---|---|
| `Config.gs` | Every setting. The only file you should need to edit. |
| `OAuth.gs` | Bitrix local-app tokens: install handler, refresh, connection test. |
| `Secrets.gs` | Picks the credential mode; webhook fallback; log redaction. |
| `BitrixClient.gs` | The only code that calls Bitrix. Retry, backoff, throttling. |
| `DateUtils.gs` | Calendar arithmetic and cell-to-date parsing. |
| `SheetReader.gs` | All spreadsheet reads and writes. |
| `FollowUpEngine.gs` | The processing logic, shared across all three types. |
| `Main.gs` | Entry points, locking, continuation, email reporting. |
| `appsscript.json` | Manifest: scopes, timezone, web app settings. |

---

## Setup

### 1. Add the Deal ID columns

| Tab | Deal ID column |
|---|---|
| Quick Check Updated | **E** |
| Business Plus Updated | **F** |
| Annual Review Updated | **I** |

Give each a header (e.g. `Bitrix Deal ID`). Leave the cells empty. A row with anything in this cell is never processed again — this is what prevents duplicate deals, so don't clear it manually unless you intend a re-import.

### 2. Create the script files

In the Sheet: **Extensions → Apps Script**. Create each file above (`+` → Script) using the exact names minus `.gs`, and paste the contents in.

**Keep the default `Code.gs` if you're using it for your own code** (e.g. routines that populate this sheet from other Google Sheets). Only delete it if it still contains the empty `myFunction()` stub Apps Script generates.

> Every `.gs` file in a project shares one global namespace — they are not modules. Before pasting, check `Code.gs` for names that collide with these files. A duplicate `function` name silently overwrites the other; a duplicate top-level `const` or `let` is worse, breaking **every** function in the project at load. See *Coexisting with your own code* below.

For `appsscript.json`, first tick **Project Settings → Show "appsscript.json" manifest file in editor**, then paste it over the generated one.

> ⚠️ **Re-authorize immediately after pasting.** These files need scopes the project did not previously require. Changing required scopes invalidates the existing authorization, and **any existing time-driven trigger fails until the owner re-consents**. Google reports this only via a "Summary of failures for Google Apps Script" email.
>
> Run any function from the editor dropdown (`showOAuthStatus` is harmless and touches nothing) and accept the consent screen. That re-authorizes every trigger at once. Then check **Executions** the next morning to confirm everything ran.

### 3. Connect to Bitrix

The script authenticates as a **local application** (OAuth). It holds a one-hour access token and a refresh token rather than a permanent all-powerful URL, and it is scoped to `crm` only.

**a. Deploy the install handler.** Deploy → New deployment → **Web app**, Execute as **Me**, Who has access **Anyone**. Copy the `/exec` URL.

**b. Register the app.** Bitrix24 → Developer resources → Other → **Local application**:

| Field | Value |
|---|---|
| Type | **Server** (not Static — Static has no client secret and no server callback) |
| Your handler path | the `/exec` URL |
| Initial installation path | **the same `/exec` URL** |
| Script only (no user interface) | leave unchecked — see below |
| Supports BitrixMobile | unchecked |
| Menu item text | anything, e.g. `Follow-Up Sync` |
| Assign permissions | `CRM (crm)` |

Set **both** path fields to the same URL. "Initial installation path" is what Bitrix calls during installation and takes precedence over the handler when set, so filling both guarantees `doPost` receives the tokens either way.

**Script only** controls whether the app gets a menu item in the Bitrix left nav. Ticking it keeps the nav clean; the trade-off is that unticked is the classic, best-documented install handshake (Bitrix opens the handler in an iframe and POSTs `AUTH_ID`/`REFRESH_ID`, exactly what `doPost` expects), whereas script-only apps may install differently.

Try it ticked. If it works you keep the clean menu; if not, untick and install again. To tell which happened, open **Executions** in the Apps Script editor:

| Executions shows | Meaning | Fix |
|---|---|---|
| A `doPost` run | Bitrix reached the handler; `installRefused_` logged the reason (`not armed`, `unexpected domain`, `missing AUTH_ID or REFRESH_ID`) | fix that specific thing — arm first, or correct `BITRIX_PORTAL_DOMAIN` |
| No `doPost` run at all | Bitrix never called the handler | untick **Script only**, save, install again |

Save, then copy the application ID and key.

**c. Store the settings.** Project Settings → Script Properties:

| Property | Value |
|---|---|
| `BITRIX_CLIENT_ID` | the application ID (`local.xxxxx`) |
| `BITRIX_CLIENT_SECRET` | the application key |
| `BITRIX_PORTAL_DOMAIN` | `YOUR_PORTAL.bitrix24.com` |
| `BITRIX_AUTH_MODE` | leave as `webhook` for now |

**d. Install.** Run `armInstall()` in the editor, then click **Install** on the local application in Bitrix. Bitrix POSTs the tokens straight to your handler. Run `showOAuthStatus()` to confirm both tokens are set.

> ⚠️ **After ANY edit to `OAuth.gs`, redeploy before installing.** Functions run from the editor always execute the latest code ("Head"), but a deployed web app runs a **pinned version snapshot**. `doPost` therefore keeps running whatever the code looked like when you last deployed — silently, with no error to tell you.
>
> To update it: **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The `/exec` URL is preserved, so nothing changes in Bitrix.
>
> To spot the problem: in **Executions**, the third column shows `Head` for editor runs and a version name for web app runs. If `doPost` shows an old version while your edits are in `Head`, that is the bug.

**e. Switch over.** Set `BITRIX_AUTH_MODE` to `oauth`.

**f. Close the door.** Deploy → Manage deployments → pencil icon → Who has access **Only myself** → Deploy. The URL is preserved; token refreshes are outbound calls and need no inbound endpoint.

Never paste a client secret or webhook URL into a `.gs` file. Anyone who can edit the Sheet can read the script, and version history keeps whatever was there.

> **Rollback.** The old webhook path still works. Set `BITRIX_AUTH_MODE` to `webhook` and make sure `BITRIX_WEBHOOK_URL` is still present (Script Properties → see `Secrets.gs`). No code change, no redeploy.

### 4. Match the timezones

Project Settings → check the script's timezone matches the Sheet's (File → Settings). If they differ, dates can evaluate a day early or late. The script warns you if they don't match, but fix it before going live.

### 5. Fill in the header names

In `Config.gs`, `expectedHeaders` currently uses guesses (`'name'`, `'approval'`, `'contact'`). Replace each with real text from row 1 of your sheets — a distinctive substring is enough, matched case-insensitively (and works for accented or non-English headers too, since it's a substring match).

This is what stops a wrong-data disaster: if someone inserts a column, every field shifts and the script would otherwise write approval dates into expiration fields without any error. With headers set, the tab is skipped and you get an email instead.

Set a value to `''` to skip checking that column.

### 6. Set the cutoff date

`CONFIG.CUTOFF_DATE` — a placeholder by default. Set it to the day you enable the daily trigger. No deal is ever created for a row due before this date, which keeps your existing historical rows dormant instead of flooding Bitrix with years of backlog on the first run.

### 7. Verify

Run in this order from the editor's function dropdown:

1. **`testBitrixConnection`** — should log `Mode: oauth. Connected to CRM: <N> deal fields visible.` and confirm every field in `CONFIG.FIELDS` exists on the deal. Authorize when prompted.
2. **`dryRunFollowUpDeals`** — creates nothing. Check the log (View → Executions) and confirm the deals it lists match what you'd expect for today.
3. **`createFollowUpDeals`** — the real thing. Verify the deals in Bitrix, then confirm the Deal IDs appear in your sheets.

### 8. Add the daily trigger

Clock icon → **Add Trigger**:

- Function: `createFollowUpDeals`
- Event source: Time-driven → Day timer
- Time: early morning (e.g. 6–7am)

Add only this one. The script creates its own short-lived continuation triggers when needed and cleans them up afterwards — leave those alone.

---

## Coexisting with your own code

This project shares its Apps Script project (and its global namespace, its OAuth scopes, and its 6-minute execution limit) with whatever else lives there — such as a `Code.gs` you use to populate the sheet from elsewhere.

### Names claimed by these files

Anything below will collide if your own code declares the same name. Duplicate **functions** resolve silently to whichever file loads last; duplicate top-level **`const`/`let`** throws at load and disables the entire project until fixed.

**Variables** — `CONFIG`, `OAUTH_KEYS`, `OAUTH_TOKEN_ENDPOINT`, `WEBHOOK_PROPERTY_KEY`, `AUTH_MODE_PROPERTY_KEY`, `CONTINUATION_HANDLER`, `SCRIPT_LOCK_HELD_`, `LAST_REQUEST_AT_`, `INSTALL_ARM_WINDOW_MS`, `TOKEN_EXPIRY_MARGIN_MS`, `ASSUMED_TOKEN_LIFETIME_S`

`CONFIG` is the one to check first — it's a common name and it fails loudly.

**Entry points** — `doPost`, `createFollowUpDeals`, `dryRunFollowUpDeals`, `continueFollowUpDeals`, `armInstall`, `disarmInstall`, `testBitrixConnection`, `showOAuthStatus`

`doPost` matters most: a project can only have one, and here it is the Bitrix install handler. If your own code already defines `doPost` or you need one for something else, the two must be merged into a single dispatcher rather than both existing.

Everything else is suffixed with `_` (`bitrixCall_`, `normalizeDate_`, `getSheet_`, …). Collisions there are unlikely but not impossible — check any private helpers with generic names.

### Scopes

`appsscript.json` lists scopes **explicitly**, which switches off Apps Script's automatic inference for the whole project. The four declared scopes cover this project's own needs:

| Scope | Needed by |
|---|---|
| `.../auth/spreadsheets` | this project; and any code of yours that opens an external spreadsheet (`openById`/`openByUrl` need the full scope, not `spreadsheets.currentonly`) |
| `.../auth/script.external_request` | calling Bitrix |
| `.../auth/script.scriptapp` | continuation triggers |
| `.../auth/script.send_mail` | alert emails |

If your own code uses `DriveApp`, `GmailApp`, `CalendarApp` or an Advanced Service, add its scope here too — with inference off, an undeclared scope fails at runtime with a permission error.

Changing scopes forces a fresh authorization prompt and **invalidates existing web app deployments** — re-deploy afterwards, or the Bitrix install handler stops responding.

### Trigger ordering

If your own code populates the tabs this project reads on its own daily triggers, schedule `createFollowUpDeals` in a **later hour block** than those, so each day's new rows exist before deals are created. Apps Script hour blocks are approximate, so leave a gap.

Getting the order wrong is not damaging: a row is processed when due *on or before* today, so anything missed is caught the next day. It only delays those deals by 24 hours.

If your population code takes no lock, note that `runFollowUp_` holds the script lock for its whole run — overlap cannot corrupt anything, but a sync writing mid-run means the follow-up pass may miss rows added after it read the tab.

> ⚠️ **The Deal ID columns are load-bearing.** A row with anything in that cell is never processed again — that is the sole duplicate guard. If your own code ever writes a block wide enough to blank one of them, every affected row is treated as new and **duplicate deals are created in Bitrix**. Keep any write range narrower than its Deal ID column.

### Execution time

Both codebases share the 6-minute limit, but not the same run: `createFollowUpDeals` has its own trigger, and its budget (`MAX_DEALS_PER_RUN`, `MAX_RUNTIME_MS`) is measured per execution. A separate sheet-population trigger doesn't eat into it. Only avoid calling one from inside the other.

---

## Behaviour

**Trigger rules**

| Tab | Fires when |
|---|---|
| Quick Check Updated | Column D (Expiration) is 3 months away |
| Business Plus Updated | Column C (Enter in Contact) has arrived |
| Annual Review Updated | Column E (Enter in Contact) has arrived |

**Quick Check's column layout differs from Business Plus/Annual Review on purpose** — column B is an extra column not read by the script at all, included as a working example of how `Config.gs`'s column indices only need to match your own sheet, not each other:

| Quick Check Updated col | Contents |
|---|---|
| A | Name |
| B | *(unused by this script — an example of an unrelated column)* |
| C | Approval Date |
| D | Expiration Date — the trigger column |
| E | Bitrix Deal ID |

**Field mapping**

| Sheet column | Bitrix field |
|---|---|
| Quick Check col C | Quick Check Approval Date |
| Quick Check col D | Quick Check Expiration Date |
| Business Plus col B | Starter Approval Date |
| Business Plus col C | Initial Contact Date |
| Annual Review col B | Starter Approval Date |
| Annual Review col C | Business Plus Submission Date |
| Annual Review col D | Eligibility Flag (enum) |
| Annual Review col E | Initial Contact Date |

Every deal also gets `Follow-Up Deal Type`, the pipeline/stage/assignee configured in `CONFIG.PIPELINE_ID` / `CONFIG.ENTRY_STAGE_ID` / `CONFIG.ASSIGNED_BY_ID`. Title is `<column A> - <Quick Check\|Business Plus\|Annual Review>`.

**Missed runs self-heal.** A row is processed when it's due *on or before* today and has no Deal ID. If the trigger fails to run for two days, the next run catches up rather than dropping those clients permanently. The Deal ID column is what makes this safe.

**Eligibility Flag column** accepts `Yes`/`No`/`Y`/`N`/`Eligible`/`Not eligible`/`1`/`0`/checkbox booleans. Anything else, including blank, becomes **Unknown** — never guessed.

**Large runs resume.** At 120 deals or 4.5 minutes, the run stops cleanly and schedules a continuation two minutes later. Apps Script's hard limit is 6 minutes with no cleanup opportunity, so stopping voluntarily is the only safe option.

**Email to `CONFIG.ALERT_EMAIL`** on any failure, aborted tab, unreadable date, or config warning. Clean runs are silent by default — set `ALWAYS_EMAIL: true` if you'd rather have a daily confirmation, at least for the first week.

---

## Advanced: scoped runs

`runFollowUp_` (in `Main.gs`) takes an options object beyond the two the daily trigger uses. A normal call — `{ dryRun, isContinuation }` — processes every sheet from `CONFIG.CUTOFF_DATE` through today, exactly as described above. The remaining fields are all optional and let you scope a single run without touching the daily trigger's own state:

| Option | Effect |
|---|---|
| `sheetKeys` | Array of sheet keys to process, e.g. `['QUICK_CHECK']` (default: all three) |
| `windowStart` / `windowEnd` | `'YYYY-MM-DD'` bounds used in place of `CONFIG.CUTOFF_DATE` / today |
| `continuationHandler` | Function name to resume with if the run exceeds its budget |
| `alwaysNotify` | Force a summary email even when the run finds nothing to do |
| `label` | Text shown at the top of the run report, so it's easy to tell apart from the daily run's own log entries |

This is useful for a one-off historical catch-up — for example, if the daily trigger only gets enabled well after go-live and a specific window of already-elapsed follow-ups still needs to be pushed once. Add a small temporary file with its own entry points:

```js
function runHistoricalCatchup() {
  return runFollowUp_({
    dryRun: false,
    sheetKeys: ['QUICK_CHECK'],
    windowStart: '2024-01-01',
    windowEnd: '2024-06-30',
    continuationHandler: 'continueHistoricalCatchup',
    alwaysNotify: true,
    label: 'One-time historical catch-up'
  });
}

function continueHistoricalCatchup() {
  cleanUpContinuationTriggers_('continueHistoricalCatchup');
  return runFollowUp_({
    isContinuation: true,
    sheetKeys: ['QUICK_CHECK'],
    windowStart: '2024-01-01',
    windowEnd: '2024-06-30',
    continuationHandler: 'continueHistoricalCatchup',
    alwaysNotify: true,
    label: 'One-time historical catch-up (continued)'
  });
}
```

**Always dry-run a scoped window first** (`dryRun: true`) and read the per-row detail in the log before creating anything.

The dedicated `continuationHandler` matters for exactly one reason: if a scoped run is large enough to hit `MAX_DEALS_PER_RUN` or `MAX_RUNTIME_MS`, it schedules its own continuation trigger rather than the daily one — so resuming it can never silently fall back to processing every sheet with today's date instead of the scoped window. Give every scoped run its own continuation function name, matching the pattern above.

Once a scoped run has done its job, its temporary file can simply be deleted — nothing else in the project depends on it, since `runFollowUp_`'s extra options are just unused defaults for the normal daily call.

---

## Operational notes

**Unreadable dates** are reported by row number and retried on the next run, so fixing the cell is all that's needed.

**A failed row doesn't stop the others.** Each failure is logged with its row number and emailed; the run continues.

**Client names are kept out of the logs** by default (`LOG_CLIENT_NAMES: false`), since execution logs are visible to anyone who can open the script. Set it to `true` temporarily if you're debugging a specific client.

**Credentials are stripped** from anything logged or emailed — webhook URLs, access tokens, refresh tokens and the client secret. Bitrix echoes the request URL, and sometimes the body, in error payloads.

**Tokens refresh themselves.** The access token lasts an hour and is renewed automatically; each renewal also issues a new refresh token. You should never need to touch this.

**Re-authorising** is only necessary if the chain actually breaks — the script sat unused for a month, the secret was rotated, or the app was uninstalled. You'll know because the run fails and emails you. It takes about three minutes:

1. Manage deployments → pencil → access **Anyone** → Deploy
2. Run `armInstall()`
3. Click **Install** in Bitrix
4. Run `testBitrixConnection()` to confirm
5. Manage deployments → pencil → access **Only myself** → Deploy

**The 30-day dormancy limit** is the one real cost of OAuth over the old webhook: a refresh token dies if unused for roughly a month. The daily trigger keeps it alive indefinitely, so this only bites if the script is disabled for a long stretch.

**To re-import a row deliberately**, clear its Deal ID cell. It will be recreated on the next run if still within the cutoff window.

**If you edit the Bitrix dropdowns**, re-run `crm.item.fields.json?entityTypeId=2` and update the item IDs in `CONFIG.ENUMS`. Bitrix stores the numeric ID, not the text, so renaming an option is safe but adding/removing changes the IDs.

---

## Known limitation

Every deal type is created into the same `CONFIG.ENTRY_STAGE_ID`, regardless of which of the three tabs it came from. If your pipeline doesn't have distinct stages/automation to route each deal type onward from there, deals will simply accumulate in that entry stage over time. This doesn't block anything, but it's worth building out that routing before volume grows.

## License

[MIT](LICENSE)
