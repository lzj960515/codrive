# Documentation log

## 2026-08-26

- Defined `PROJECT.md` as the only current product-facts source.
- Added local-file change notification, optimistic concurrency, planning invalidation, and lifecycle audit.
- Established state schema v3 as the only startup contract and removed prior context, state conversion, report identity, update API, and managed-resource upgrade fallbacks.
- Restored a bounded, backed-up schema-v2 to schema-v3 startup upgrade after the strict v3 release prevented existing installations from starting.
- Removed historical product notes and project execution diagnostics from product detail.
