# Changelog

## 0.3.2

- Fixes budget limits being skipped for invoices with no parseable amount, relay events being accepted without signature verification, out-of-range ratings skewing reputation averages, and malformed price tags parsing as NaN — upgrade recommended.
- Hardens `discover()` so a single malformed capability event can no longer abort the whole batch. With price-tag validation now (correctly) throwing on a malformed amount, one hostile or misbehaving relay event would otherwise make `discover()` throw and drop *every* valid capability. Each event is now parsed independently — a malformed event is skipped and logged (`console.warn`), and the valid capabilities are still returned.
- **Behaviour break:** when a maximum amount is configured, an invoice whose amount cannot be determined — none encoded, unparseable, or zero — now throws instead of being paid. Previously an undetermined amount was read as "no limit applies" and reached the wallet callback unchecked. Callers relying on paying amountless invoices must use invoices with explicit amounts, or configure no maximum to opt out of limits, in which case behaviour is unchanged.
