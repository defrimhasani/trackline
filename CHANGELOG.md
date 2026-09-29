# Changelog

All notable changes to Trackline are listed here. The release workflow turns the **Unreleased** section into the notes for the next release.

## Unreleased

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
