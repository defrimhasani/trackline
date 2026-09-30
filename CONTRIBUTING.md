# Contributing to Trackline

Thanks for helping make Trackline better. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** open an issue using the templates, so there's context before code.
- **Security problems:** don't open an issue. Follow [SECURITY.md](SECURITY.md) instead.
- **Larger changes:** open an issue first to agree on the approach.

## Development setup

You need Node.js 20+, stable Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev
```

Development builds store Jira credentials in the git-ignored `src-tauri/.trackline-dev.json`. Never commit credentials, tokens or real Jira data, including in screenshots.

## Making a change

1. Branch from `main`.
2. Keep changes focused and consistent with the surrounding code, the design system in [DESIGN.md](DESIGN.md) and the product principles in [PRODUCT.md](PRODUCT.md).
3. Add a line under **## Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
4. Check that these pass locally, as CI runs the same checks:

   ```bash
   npm run build
   cd src-tauri && cargo clippy --all-targets -- -D warnings
   ```

5. Open a pull request and fill in the template.

## Releases

Merging to `main` publishes a release automatically. Maintainers can add `[minor]`, `[major]` or `[skip release]` to the merge commit message. See the README for details.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part, you agree to uphold it.
