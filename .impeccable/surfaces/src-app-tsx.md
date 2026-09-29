---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

# Week calendar — Operate

## Scope

The desktop worklog calendar is the main daily surface for Jira Cloud work. The user scans a week, logs time against issues, opens issue context, and begins a scoped export.

## Direction contract

**THESIS:** Make a Jira workweek feel like a dispatch board: precise, continuous, and immediately actionable—not a collection of generic dashboard cards.

**OWN-WORLD:** Midnight-blue operating ground, frost-white data plates, teal as the live route, and restrained coral for attention. Fine route rules, station-dot markers, disciplined numerals, and humanist workhorse UI type define the system.

**STORY:** In seconds, a user sees which days are fully logged, what issue work occupied them, and the remaining time gap. A single primary action starts a time entry; export is available but never competes with daily logging.

**FIRST VIEWPORT:** A slim rail on the left holds the mark, week navigation, view controls, and Today. The center owns a full five-day timetable; each day column carries its date and target, while worklog blocks anchor to hourly rows. A right-side pulse panel shows today's logged/target total, recent issues, and the 4 PM reminder state. The “Log time” control is fixed at the upper right.

**FORM:** Transit dispatch timetable, sixth grounded direction; seed `d7a023a1`. The active-day route line crosses the grid, and hover/focus reveals precise worklog details without obscuring the schedule.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
