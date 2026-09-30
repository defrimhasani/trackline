# Changelog

All notable changes to Trackline are listed here. The release workflow turns the **Unreleased** section into the notes for the next release.

## v0.5.1 — 2026-09-30

### Improved
- **Simpler tickets export.** `trackline-team-tickets-….csv` now ends with a single **Total** row summing the hours logged in the period, instead of repeating each ticket's all-time total. The Estimate and all-time Total logged columns are removed, so every number in the file belongs to the exported week or month.

## v0.5.0 — 2026-09-30

### New
- **Recurring worklogs.** In Log time, turn on **Repeat on several days** to log the same issue, duration, start time and description across a date range, on the weekdays you choose (Mon–Fri by default). A preview shows how many worklogs will be created and the total time before you save. Useful for annual leave or a daily scrum. ([#4](https://github.com/defrimhasani/trackline/issues/4), thanks @fitahmeti)
- **Last sync time.** Under the date, the top bar now shows when the calendar or Worklogs page was last loaded from Jira (for example "synced 10:42"). Use the Refresh button next to the theme toggle, or ⌘R / Ctrl+R, to pick up changes made directly in Jira. ([#5](https://github.com/defrimhasani/trackline/issues/5), thanks @fitahmeti)

### Improved
- **Durations in minutes.** The duration field accepts Jira-style durations: `15m`, `30m`, `2h`, `1h 30m`, `1:30`, `1d` (one workday), or hours as a number (`1.5`). Quick buttons fill in common durations, and the field shows what it understood, such as "= 1h 30m". ([#3](https://github.com/defrimhasani/trackline/issues/3), thanks @fitahmeti)

### Fixed
- Field labels in the Log time dialog are readable again in dark mode.

## v0.4.3 — 2026-09-30

### Security
- Trackline now refuses to send your Jira credentials anywhere except over HTTPS, even if the saved site address were changed.
- The release workflow now has read-only access by default; only the jobs that publish releases can write.

## v0.4.2 — 2026-09-30

### Security
- **Verifiable downloads.** Every installer now has a signed build provenance attestation from GitHub Actions. Check any download with `gh attestation verify <file> -R defrimhasani/trackline`.
- **Security scanning.** The repository now runs CodeQL code scanning, secret scanning with push protection, Dependabot alerts and updates, dependency review on pull requests, and OpenSSF Scorecard. Vulnerabilities can be reported privately; see `SECURITY.md`.
- Release and website workflows pin every GitHub Action to an exact commit and only use the permissions they need.

## v0.4.1 — 2026-09-29

### Improved
- **Clearer period controls.** The top bar now reads **Today · ‹ › · title**, with Today as a proper button, the previous and next arrows grouped together, and a larger week or month title, without the gap that used to split them.

### Fixed
- In dark mode, the empty daily progress bar under the week view's day headers no longer shows as a bright white line.

## v0.4.0 — 2026-09-29

### New
- **Edit worklogs.** Click an entry in the calendar and choose **Edit** to change its duration, day, start time or description. Changes are saved straight to Jira. To move time to a different issue, delete the worklog and log it again (Jira doesn't allow moving a worklog between issues).
- **Delete worklogs.** Choose **Delete** on an entry and confirm to remove it from Jira.

### Improved
- The worklog details show the day and start time, and say "No description" when a worklog has none.

## v0.3.1 — 2026-09-29

### Fixed
- **Far fewer keychain prompts on macOS.** Trackline now keeps your Jira credentials in a single keychain item and reads it once per session, instead of reading five separate items on almost every request. Existing credentials move over automatically, so you don't need to reconnect. Choose **Always Allow** when macOS asks, and it won't ask again until the next update.

### New
- **Refresh button.** The top bar has a Refresh button (or press ⌘R / Ctrl+R) that reloads the current week or month from Jira in the calendar and on the Worklogs page. Your entries stay on screen while it loads.

## v0.3.0 — 2026-09-29

### New
- **Automatic updates.** Trackline checks for new versions when it starts and every few hours. When one is available, a bar at the top shows what's new with an **Update and restart** button. You can also check any time in **Settings → Updates**.

### Note
- Versions before this one can't update themselves. Download this release once from the website or GitHub; from then on Trackline keeps itself up to date.

## v0.2.0 — 2026-09-29

### New
- **Tickets view.** The Worklogs page now switches between **People** and **Tickets**. Each ticket shows its issue type, status and parent, **Work type**, **Cost/Capitalized**, original estimate, hours logged in the selected week or month, total logged against the estimate (with over-estimate highlighted), and everyone who logged time on it.
- **Capitalization summary.** Above the Tickets table, a bar splits the period's hours into Capitalized, Cost and Not set, next to hours per work type. Both follow the active filters.
- **Find and sort tickets.** Filter by ticket, summary or person, by work type or by cost type, and sort any column. Click a ticket to see each person's entries for the period and open it in Jira.
- **Per-ticket CSV.** Team export now saves a third file, `trackline-team-tickets-….csv`, with one row per ticket and all of the columns above.
- **Jira fields setting.** Trackline finds your Work type and Cost/Capitalized custom fields by name. Change them, or turn one off, in **Settings → Jira fields**.
- **Month picker.** In month view, click the month name in the top bar to jump to any month and year.

### Improved
- Your light or dark theme is now remembered between sessions.
- Long work type names wrap in the Tickets table instead of being cut off.

## v0.1.0 — 2026-09-29

First public release.

- Week and month calendar of your Jira Cloud worklogs, with overlapping entries side by side and a timeline that stretches to early and late entries.
- Log time by clicking the calendar or with the Log time dialog: pick an issue from Recent activity, Recently viewed, or search all of Jira. Worklogs are written straight to Jira.
- Focus on incomplete days, a configurable workday length, and a hide-weekends toggle.
- Team worklogs: a people × days grid for chosen projects plus pinned teammates.
- CSV export for your own worklogs, or a team summary plus every worklog line.
- Side panel with today's progress, days that need attention, and recently worked issues.
- Daily reminder notification, light and dark themes, and a resizable window.
- Installers for macOS (Apple Silicon and Intel), Windows and Linux.
