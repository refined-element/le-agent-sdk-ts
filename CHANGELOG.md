# Changelog

## 0.3.4

**Security fix — upgrade recommended.** Two fail-closed hardenings of L402 payment:

- The amount/budget gate no longer pays an invoice whose amount can't be bounded when no `maxAmountSats` is configured (an unset max previously skipped the check and paid anything). Unknown/unbounded/non-positive amounts are refused regardless of the max; a known positive amount with no max still pays.
- The BOLT11 amount decoder is now HRP-anchored, so a crafted invoice can't smuggle bech32 data-part digits into a bogus positive amount that would pass the budget check with a fabricated number.

## 0.3.3

- **Packaging fix — 0.3.1 and 0.3.2 were not importable.** The published npm tarball was missing the compiled `dist/` output: `dist/` is git-ignored and the package declared no `files` allowlist, so `npm publish` (which falls back to `.gitignore`) stripped the build output even though CI built it, leaving `main`/`module`/`exports` pointing at files that were never shipped. Any `import`/`require` failed with `MODULE_NOT_FOUND`. Adds `"files": ["dist"]` so the compiled output is always included (and `src`/`tests` are no longer shipped). No API changes — 0.3.3 is the first npm-importable release carrying the 0.3.2 fixes.

## 0.3.2

- Fixes budget limits being skipped for invoices with no parseable amount, relay events being accepted without signature verification, out-of-range ratings skewing reputation averages, and malformed price tags parsing as NaN — upgrade recommended.
- Hardens `discover()` so a single malformed capability event can no longer abort the whole batch. With price-tag validation now (correctly) throwing on a malformed amount, one hostile or misbehaving relay event would otherwise make `discover()` throw and drop *every* valid capability. Each event is now parsed independently — a malformed event is skipped and logged (`console.warn`), and the valid capabilities are still returned.
- **Behaviour break:** when a maximum amount is configured, an invoice whose amount cannot be determined — none encoded, unparseable, or zero — now throws instead of being paid. Previously an undetermined amount was read as "no limit applies" and reached the wallet callback unchecked. Callers relying on paying amountless invoices must use invoices with explicit amounts, or configure no maximum to opt out of limits, in which case behaviour is unchanged.
