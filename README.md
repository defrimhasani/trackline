# Trackline

**A calm desktop timesheet for Jira Cloud.** See your week as a calendar, log time in seconds, spot the days you missed, and export clean timesheets for yourself or your team.

Trackline is a free, open-source desktop app built with [Tauri](https://tauri.app) and React. It talks directly to your Jira Cloud site with your own API token. There is no Trackline server, no account, and no tracking.

→ **Website:** https://defrimhasani.github.io/trackline/

## Features

- **Week and month calendar** of your Jira worklogs, with overlapping entries laid out side by side.
- **Log time fast.** Click an hour in the calendar, pick an issue from *Recent activity*, *Recently viewed*, or search all of Jira, and save. Worklogs are written straight to Jira.
- **Focus on incomplete days.** Highlight working days below your daily target (8h by default, configurable) and log the missing time in one click.
- **Team worklogs.** A people × days grid for chosen Jira projects plus pinned teammates, with per-day details and the same incomplete-day focus.
- **CSV export.** Your own worklogs, or a team summary plus every individual worklog line.
- **Daily reminder.** A native notification on weekdays if you are below target at your chosen time.
- **Light and dark themes,** hide-weekends toggle, and a resizable desktop window.

## Download

Get the latest version from **[GitHub Releases](https://github.com/defrimhasani/trackline/releases/latest)**:

| Platform | File |
|---|---|
| macOS, Apple Silicon | `Trackline_<version>_aarch64.dmg` |
| macOS, Intel | `Trackline_<version>_x64.dmg` |
| Windows 10/11 | `Trackline_<version>_x64-setup.exe` or `.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

Trackline is not yet signed with a paid Apple or Microsoft certificate, so the first launch needs one confirmation:

- **macOS:** open the app, then go to *System Settings → Privacy & Security* and select **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/Trackline.app`).
- **Windows:** in the SmartScreen prompt select **More info → Run anyway**.

## Build from source

You need:

- [Node.js](https://nodejs.org) 20 or newer
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your operating system

```bash
git clone https://github.com/defrimhasani/trackline.git
cd trackline
npm install
npm run tauri dev
```

To build an installable app for your platform:

```bash
npm run tauri build
```

The bundle is written to `src-tauri/target/release/bundle/`.

## Connecting Jira

1. Create an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Open **Settings** in Trackline and enter your Jira site (for example `https://your-team.atlassian.net`), your Atlassian email, and the token.
3. Select **Connect Jira**.

Trackline can only see and change what your Jira account can.

## Privacy and security

- Your API token is stored in the operating system's credential vault (macOS Keychain and equivalents) in release builds.
- In development builds (`npm run tauri dev`) credentials are stored in `src-tauri/.trackline-dev.json` with owner-only permissions. This file is git-ignored.
- All requests go directly from your machine to your Jira Cloud site. CSV exports are saved to your Downloads folder.

## Project structure

```
src/          React UI (calendar, team worklogs, settings, dialogs)
src-tauri/    Rust backend: Jira API calls, credential storage, file export, notifications
site/         Marketing website published to GitHub Pages
```

## Contributing

Issues and pull requests are welcome. Please keep changes consistent with the design system in [`DESIGN.md`](DESIGN.md) and the product principles in [`PRODUCT.md`](PRODUCT.md).

## License

[MIT](LICENSE) © Defrim Hasani

Trackline is an independent project and is not affiliated with or endorsed by Atlassian. Jira is a trademark of Atlassian.

## Releasing

Every merge to `main` that changes the app (`src/`, `src-tauri/`, npm packages or build config) publishes a new release automatically:

1. The **Release** workflow bumps the patch version (for example `0.1.1` → `0.1.2`) in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, and commits it back to `main`.
2. It builds macOS (Apple Silicon and Intel), Windows and Linux installers and publishes them as a GitHub Release.

Put `[minor]` or `[major]` in the merge commit message for a bigger version step, or `[skip release]` to skip releasing. You can also run the workflow manually from the Actions tab and choose the bump.
