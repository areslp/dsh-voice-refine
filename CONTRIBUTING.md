# Contributing

Thanks for helping make voice input for DeepSeek Harness safer, more portable, and more useful.

## Before you start

- Open an issue before a large behavior or protocol change.
- Keep ASR and refinement integrations provider-neutral.
- Do not add deployment-specific hosts, paths, accounts, credentials, or model assumptions.
- Preserve the core safety boundary: recognized text becomes an editable draft and is never submitted automatically.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.

## Development workflow

Use Node.js `22.19+` or `24+`:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
```

When changing DSH integration code, also run the source-contract check against a compatible DeepSeek Harness checkout:

```bash
DSH_SOURCE_DIR=/path/to/deepseek-harness npm run verify:dsh-rc8-contract
```

Include focused regression tests, update the changelog for user-visible changes, and explain privacy or security trade-offs in the pull request.

## Pull requests

Keep each pull request scoped to one concern. Describe the behavior change, validation evidence, compatibility impact, and any remaining risk. Generated build output and package archives should not be committed.
