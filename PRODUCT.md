# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

Tauri + React, confirmed for a cross-platform desktop application.

## Users

People who log work against Jira Cloud issues every day, including individual contributors who need a personal record and people who need to export time for a team or project.

## Product Purpose

A desktop daily driver for reviewing and recording Jira Cloud worklogs in a calendar-first workflow. It makes daily logging quick, keeps worked issues visible, and supports personal, team, and project calendar exports.

## Positioning

A local desktop calendar and worklog workflow for Jira Cloud that remains useful throughout a workday, including a local-time reminder, rather than a timesheet task deferred to a hosted web product.

## Operating Context

Users work across time zones and need a reminder around 4 PM in their current local time when the app is running. Work is logged against Jira tickets. The application must support light and dark modes.

## Capabilities and Constraints

- Jira Cloud API integration is required in the first usable version; authentication details remain open.
- Calendar-first day, week, and month views of time logged against tickets.
- Quick worklog entry, visibility into issues worked on, and editing of logged time.
- Anyone may export a full calendar for themselves, a team, or a project; export formats remain open.
- Local notifications while the app is running, scheduled by local clock time rather than a fixed timezone.
- Cross-platform desktop delivery through Tauri.

## Evidence on Hand

No existing product assets, brand system, production Jira data, or verified API configuration were provided. Demonstration issues and worklog data must be clearly synthetic.

## Product Principles

1. Make daily time logging an easy, low-friction ritual.
2. Keep the worklog calendar legible before adding reporting complexity.
3. Treat Jira issue context as the source of truth for recorded work.
4. Make exports transparent across personal, team, and project scopes.
5. Respect the user’s current local time and attention.

## Accessibility & Inclusion

Support keyboard-first operation, clear screen-reader semantics, sufficient contrast in both themes, and do not rely on color alone to convey logged-time status.
