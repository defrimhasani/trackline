# Security policy

## Supported versions

Security fixes are released for the **latest version** of Trackline. Installed copies update themselves, so please keep automatic updates on (Settings → Updates).

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub instead: go to the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/defrimhasani/trackline/security/advisories/new)).

Include what you found, how to reproduce it, and the version you tested. You can expect an acknowledgement within a few days. Once a fix is released, the advisory is published with credit to you, unless you prefer to stay anonymous.

## How Trackline handles sensitive data

- **Jira credentials.** Your Atlassian API token, email and site address are stored in the operating system's credential store (macOS Keychain, Windows Credential Manager, Secret Service on Linux) as a single item. Development builds store them in the git-ignored `src-tauri/.trackline-dev.json` with owner-only permissions.
- **Network.** Trackline talks only to your own Jira Cloud site over HTTPS, to GitHub to check for updates, and to Atlassian and Jira for issue-type icons and avatars. There is no Trackline server and no analytics.
- **Updates.** Update bundles are signed with a private key held only by the maintainer and GitHub Actions. The app verifies every update against the public key built into it and refuses anything that doesn't match.
- **Releases.** Installers are built by GitHub Actions from this repository and carry build provenance attestations. You can verify a download with:

  ```bash
  gh attestation verify <downloaded-file> -R defrimhasani/trackline
  ```

## Scope

In scope: the Trackline desktop app, its release and update pipeline, and this repository's workflows. Out of scope: Jira Cloud itself (report those to [Atlassian](https://www.atlassian.com/trust/security/report-a-vulnerability)) and issues that need an already compromised computer.
