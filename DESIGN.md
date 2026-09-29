---
name: Trackline
description: A dispatch-board desktop calendar for Jira Cloud worklogs.
colors:
  midnight-rail: "#17263f"
  workspace-ink: "#091525"
  cool-paper: "#edf2f6"
  data-plate: "#ffffff"
  live-route: "#16a89a"
  route-mint: "#c7f0ea"
  review-blue: "#7588e9"
  attention-coral: "#ef947c"
  route-violet: "#9276d8"
  primary-ink: "#172946"
  secondary-ink: "#718199"
  divider: "#d4dfe9"
typography:
  display:
    fontFamily: "Manrope, ui-sans-serif, sans-serif"
    fontSize: "25px"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Manrope, ui-sans-serif, sans-serif"
    fontSize: "19px"
    fontWeight: 800
  body:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.54
  label:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 800
    letterSpacing: "0.1em"
rounded:
  control: "5px"
  container: "7px"
  calendar: "9px"
spacing:
  compact: "8px"
  control: "12px"
  section: "23px"
  panel: "31px"
components:
  button-primary:
    backgroundColor: "{colors.live-route}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  button-secondary:
    backgroundColor: "#e6edf4"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  worklog-teal:
    backgroundColor: "{colors.route-mint}"
    textColor: "#153852"
    rounded: "4px"
---

# Design System: Trackline

## Overview

**Creative North Star: "The Quiet Dispatch Board"**

Trackline makes timekeeping feel like a precise, continuously readable operating board. Its visual language is professional rather than severe: deep navy establishes a stable control room, cool paper keeps dense worklog data breathable, and a single live teal directs action and completion.

The system favors timetable structure, station-scale markers, and compact text over rounded dashboard-card repetition. It is designed for a desktop workday under normal office light, where a person needs to scan a full week without visual fatigue. Color identifies work types, but all logged-time status is also legible through position, labels, and duration.

**Key Characteristics:**
- Continuous weekly schedule instead of metric-first dashboard panels.
- Fine, low-contrast route rules carry dense structure without noise.
- Dark navigation rail and light data plane create stable orientation.
- Teal belongs to live action and completion; other accents distinguish work context.

## Colors

Cool operational blues create the substrate; limited route colors make active work and type of work immediately scannable.

### Primary
- **Live Route** (`#16a89a`): the primary action, active calendar meter, confirmation state, and completion signal.
- **Midnight Rail** (`#17263f`): the persistent navigation ground and identity anchor.

### Secondary
- **Review Blue** (`#7588e9`): meetings, review work, and blue-route worklogs.
- **Route Violet** (`#9276d8`): integration and system worklog distinction.
- **Attention Coral** (`#ef947c`): current-time line and attention-oriented work.

### Neutral
- **Cool Paper** (`#edf2f6`): workspace background.
- **Data Plate** (`#ffffff`): table and dialog surfaces.
- **Primary Ink** (`#172946`): high-emphasis text.
- **Secondary Ink** (`#718199`): metadata and supporting copy.
- **Divider** (`#d4dfe9`): quiet calendar and surface structure.

**The Single Signal Rule.** Teal is reserved for the action that moves the user forward and the system state that is fully current. Do not turn every interactive object teal.

## Typography

**Display Font:** Manrope, with a UI sans-serif fallback.
**Body Font:** DM Sans, with a system UI fallback.

**Character:** Manrope gives calendar headers the geometric authority of a timetable board; DM Sans keeps repeated issue names and descriptions compact, calm, and legible.

### Hierarchy
- **Display** (800, 25px, 1.15): workspace page titles and primary time totals.
- **Title** (800, 19px): dates and compact panel totals.
- **Body** (400, 13px, 1.54): descriptions, controls, and helper copy.
- **Label** (800, 10px, 0.1em): system labels, status categories, and Jira issue keys.

**The Timetable Rule.** When schedule data becomes dense, preserve the label rhythm and let visual rank come from position, weight, and spacing—not a parade of font families or oversized numbers.

## Layout

The desktop shell uses a fixed 234px navigation rail, a flexible calendar workspace, and a 286px pulse panel. The primary calendar is a five-column weekday grid with a 53px time scale. Main workspace panels use 31px side padding; local groups use 8px, 12px, and 23px rhythm steps.

At narrower desktop widths, the rail becomes icon-only at 1190px while the calendar remains a readable desktop timetable. This application has a 1120px minimum window width because the requested primary workflow is cross-platform desktop, not mobile web.

## Elevation & Depth

Trackline is flat by default. Borders, tonal surfaces, and the rail-to-workspace contrast create depth. Data plates receive one low ambient shadow (`0 9px 24px rgba(31, 53, 82, .055)`) only where they float above the cool-paper workspace; dialogs have a stronger ambient shadow (`0 22px 60px rgba(2, 10, 23, .3)`) because they temporarily protect focus.

## Shapes

Controls use compact 5px corners, utility containers use 7px, and the calendar frame uses 9px. Worklogs have a practical 4px corner and a 2px top route rule. Shapes remain quiet and functional; large pills are limited to the reminder switch and avatar.

## Components

### Buttons
- **Primary:** Live Route background, white text, 5px radius, 9px × 13px padding; it appears once per action cluster for the immediate next step.
- **Secondary:** Cool blue-gray plate with dark ink for exports and secondary tasks.
- **Hover / Focus:** Primary deepens; all focusable controls use a 2px teal focus outline with a 2px offset.

### Inputs / Fields
- **Style:** White surface, `#ccd9e6` one-pixel border, 5px radius, and 10px padding.
- **Focus:** Teal outline through `outline-color: #25a99d`.

### Navigation
- **Rail navigation:** Midnight Rail ground, muted blue-gray default ink, 8px active container, and a 2px teal inset route marker. At compact desktop widths, labels recede while the familiar icon positions remain unchanged.

### Worklog Blocks
- **Style:** Duration-positioned blocks in the timetable, each with issue key, clipped summary, and duration.
- **State:** Accent color class distinguishes work context; the 2px top rule and textual issue key prevent color-only meaning.

## Do's and Don'ts

### Do:
- **Do** use a single schedule grid as the source of visual truth for date, duration, and completion.
- **Do** reserve `#16a89a` for primary action and current/live completion.
- **Do** keep Jira issue keys in compact high-weight labels alongside readable issue summaries.
- **Do** present detailed entry and export tasks in focused dialogs with explicit cancel actions.

### Don't:
- **Don't** replace the timetable with a dashboard grid of equal cards.
- **Don't** use color as the only signal for an issue's state or type.
- **Don't** introduce decorative glow, glass effects, gradient text, or oversized pill controls.
- **Don't** add generic metric widgets where a calendar position can show the real work.
