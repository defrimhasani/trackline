---
version: 1
slug: "site-index-html"
primary_target: "site/index.html"
related_targets: ["site/styles.css","site/script.js","site/404.html"]
---

# Product page — Persuade

## Scope

Public marketing site for Trackline at `site/` (GitHub Pages, https://defrimhasani.github.io/trackline/). Static HTML/CSS/JS, relative asset paths, plus `site/404.html`.

## Audience, job, action

- Who acts: people who log time against Jira Cloud issues daily, and leads who have to chase or export a team's time.
- Belief to earn: logging Jira time can be a quick calendar ritual, and a free local desktop app can do it without a vendor in the middle.
- Action: "Get Trackline on GitHub" (primary); "Build from source" (secondary, four commands).
- Proof: high-fidelity HTML replicas of the shipped UI with clearly synthetic data (week calendar, click-an-hour logging, incomplete-day focus, team grid, export dialog, side panel, reminder). No installers, no testimonials, no counts, no pricing, no Server/DC, no AI.

## Direction contract

**THESIS:** The page is a Trackline window you scroll through: the navy rail carries the story, the paper workspace carries a live replica that changes state as you read. It refuses the category default of centered headline + static screenshot + icon-card feature grid.

**OWN-WORLD:** DESIGN.md unchanged: midnight rail columns, cool-paper workspace, white data plates, teal only for the next action and completion, coral only for missing time and the now line. Route rules and station dots run down the rail; Manrope 800 headings, DM Sans copy, 10–11px tracked labels.

**STORY:** Understand it is a desktop Jira Cloud timesheet in one line; watch the week, click-to-log, coral missed days, team grid, and CSV export happen on the replica; trust the no-server privacy route; connect in three steps; clone from GitHub.

**FIRST VIEWPORT:** Left 36% navy rail: mark, headline "A calm desktop timesheet for Jira Cloud.", one-sentence mechanism, teal "Get Trackline on GitHub" at 19px, quiet "Build from source" link, facts line. Right: the sticky board (compact icon rail + topbar + full week timetable) at near-full height; hovering an hour previews a 15-minute slot, clicking opens the log dialog.

**FORM:** Pinned product theatre (sticky replica driven by scroll steps), position 4 on the ordered list, dealt as the lead; seed key `4ebd26c9`. Signature interaction: click any hour on the replica to open the log-time dialog pre-filled with that day and time.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Decisions made without the user

- Questions skipped at the user's instruction; answers inferred from the brief.
- Code-led build (no image generation available); dealt lead locked without a decision page.
- DESIGN.md is not rewritten: this is a surface inside the established world and the user limited writes to `site/` and this brief.
