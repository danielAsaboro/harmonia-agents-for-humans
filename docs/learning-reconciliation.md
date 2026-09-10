# Observation reconciliation API

An unknown X metrics read retains its budget reservation. The scheduler never repeats that read. A workspace owner or administrator can record a resolution through the authenticated browser-session API. Workers, Telegram principals and ordinary members cannot reconcile these reservations.

`GET /api/learning/reconciliation` returns unresolved collections, exact item and window references, the dispatch token and digest, original unknown receipt digest, current reconciliation digest, and reserved maximum. The original unknown receipt remains immutable.

`POST /api/learning/reconciliation` requires these fields from that response:

- `collectionId`, `token`, `dispatchDigest`, `originalReceiptDigest`.
- `expectedReconciliationDigest`: the current digest, or `null` for the first resolution.
- `requestId`: a stable administrator request identity. Repeat the same body after an uncertain response. Changing a body under the same identity is rejected.
- `outcome`: one of the values below.
- `evidence`: `kind` (`operator_attestation`, `provider_audit`, or `provider_response`), `reference`, `detail`, and ISO `checkedAt`. The host retains the supplied evidence with its digest and authenticated actor.
- `providerResult`: `null`, except for a recovered result. A recovered result requires `provider_response` evidence and the exact `collectionId`, `token`, provider `checkedAt`, `outcome` (`available` or `unavailable`), and `metrics` (likes, replies, reposts, quotes, optional impressions; `null` when unavailable).

| Outcome | Observation and budget disposition |
| --- | --- |
| `confirmed_not_dispatched` | Records unavailable measurement and releases the reservation. |
| `confirmed_dispatched_with_estimated_cost` | Records unavailable measurement and settles the original configured upper-bound estimate. |
| `confirmed_provider_result` | Validates the supplied result against the original item, publication receipt and measurement window, records it with the administrator's evidence lineage, and settles the configured estimate. |
| `still_unknown` | Retains the unknown observation and reservation. A later resolution must reference this new reconciliation digest. |

The API performs no provider read. Recovered results are attributed to the administrator who supplied the provider evidence. Actual cost remains `null`; configured estimates are explicitly marked `configured_upper_bound_estimate`. A settled or released reservation cannot be adjusted twice or changed by a conflicting resolution. Withdrawn job, source or publication authority blocks a new resolution.

Evaluations retain immutable cohort member IDs, digests, statuses and windows. Later collection results extend observation lineage without changing historical missingness or revoking an approved strategy. Erasure, evidence revocation and forged replacements remain invalidating events. Inference receives separate `performanceEvidenceRefs` and `advisoryEvidenceRefs`; only available performance observations and measured evaluations can support performance claims.
