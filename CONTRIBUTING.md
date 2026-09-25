# Contributing

Thank you for helping improve HarnessOrbit. Bug reports, clearer documentation, focused fixes, and reproducible agent integration results are welcome.

## Getting started

1. Fork the repository and create a branch for your change.
2. Use Node.js 22+ and Git. The offline suite needs no Herdr installation, provider credentials, or npm dependencies.
3. Run the checks before opening a pull request:

```bash
npm test
npm run check
```

`npm run test:herdr` runs a read-only integration probe against your installed Herdr CLI. Live agent testing is separate and opt-in:

```bash
npm run smoke -- --live --happy
npm run smoke -- --live
```

Live tests use your configured Claude Code and may incur provider charges. They create their own fixture repositories under `work/`. Inspect any trust or permission prompt before responding. Keep those fixtures, transcripts, credentials, and state files out of commits.

## Before changing behavior

- Describe the problem and expected outcome. Open an issue first for large changes to orchestration, adapters, or public interfaces.
- Keep one pull request focused on one concern. Explain behavior changes and add regression coverage where it protects a meaningful boundary.
- Preserve existing model/provider configuration. Do not make ordinary test runs launch agents, install tools, or require secrets.
- Mock native-agent tests must isolate configuration and session storage before daemon/worker startup. Verify synthetic sessions stay out of the user's normal history; unchanged provider files alone do not prove isolation. Do not copy user credentials or plugins into mock fixtures.
- Keep task/attempt identity, result verification, cancellation, and integration recovery explicit. Read [architecture](docs/architecture.md) and [states](docs/states.md) before changing these paths.
- Avoid runtime dependencies unless they are justified and discussed. HarnessOrbit currently runs on Node's standard library.
- Distinguish a launch adapter from a verified live integration. Include tool versions and sanitized evidence for new agent support; do not infer it from a mocked test alone.

## Documentation

English is the default. Keep `README.md` and `README.zh-CN.md` aligned when changing user-facing behavior. The files under `docs/zh-CN/` are the Chinese counterparts of the English documents under `docs/`.

Use repository-relative links and generic paths. Update examples when changing CLI options or task fields. Do not add badges, benchmark numbers, or compatibility claims that the project has not verified.

## Pull requests

Explain why the change is needed, what users will observe, and which checks actually ran. Note any remaining gaps. CI runs offline tests and syntax checks on macOS and Linux; it does not run a paid model or establish live compatibility for those platforms.

Please follow the [code of conduct](CODE_OF_CONDUCT.md). Security reports should follow [SECURITY.md](SECURITY.md), not a public issue or pull request.

## License

By intentionally submitting a contribution for inclusion in this project, you agree to license that contribution under [Apache-2.0](LICENSE), unless you explicitly state otherwise as described in the license. Do not submit third-party material without the required rights and attribution.
