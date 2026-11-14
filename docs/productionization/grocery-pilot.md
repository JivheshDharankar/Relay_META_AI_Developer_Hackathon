# Relay Grocery Procurement Pilot — Productionization Plan

## Product scope

The first live pilot is grocery procurement for one consenting Indian housing society. Keep the workflow narrow: a community grocery request, supplier discovery, RFQ dispatch, genuine supplier quotations, quote comparison, explicit authorization, supplier order acceptance, payment, carrier/delivery evidence, and reconciliation.

## Truthfulness contract

Every commercial or operational claim must retain provenance and a mode label: `LIVE`, `SANDBOX`, `SIMULATED`, `INDICATIVE`, or `UNVERIFIED`. A discovery listing is not a verified supplier; an email dispatch is not a quotation; an AI-generated PO is not supplier acceptance; a payment intent is not captured funds; a generated tracking reference is not carrier tracking; and an AI assertion is never proof of delivery.

Never allow simulated providers to be selected in pilot mode. Never silently fall back from a live provider to a mock provider. If an integration is unavailable or its outcome is uncertain, stop the affected transition, preserve evidence, and surface an actionable exception.

## Current repository baseline (verified from code)

- Model provider defaults to `mock`; Meta provider implementations exist.
- Supplier discovery defaults to `mock`; Geoapify exists, but place discovery does not verify wholesale status, stock, pricing or supplier identity.
- Supplier RFQ contact defaults to `mock`; a Resend email provider exists. Successful email dispatch is not a supplier response.
- Supplier purchase-order execution currently has a mock adapter; no live supplier order/acceptance adapter was found.
- Payment execution defaults to `MockPaymentProvider`; `SandboxPaymentProvider` is also simulated. Neither is a real-money gateway.
- Delivery tracking defaults to `MockDeliveryTrackingProvider`; it fabricates carrier/status information.
- Payment execution has idempotency and uncertain-outcome handling that must be preserved and extended for a real gateway.

## Pilot readiness gate

`RELAY_RUNTIME_MODE=demo` retains current development/demo behavior. `RELAY_RUNTIME_MODE=pilot` fails startup with a list of blockers until live model, discovery and RFQ configuration is present and the missing supplier-order, payment and logistics adapters plus verified supplier onboarding are implemented. This is intentionally fail-closed; it does not claim that the pilot is currently launchable.

## Implementation sequence

1. Provider provenance, demo/pilot separation, and fail-closed readiness gate.
2. Supplier onboarding and verification records; grocery taxonomy, units, pack sizes, freshness/expiry and delivery-area constraints.
3. Live RFQ delivery and durable inbound supplier-response ingestion with verified sender identity, deduplication and audit events.
4. Supplier-specific purchase-order adapter and explicit supplier acceptance evidence.
5. Real payment gateway integration with mandate enforcement, idempotency, signed webhooks, status lookup, refunds and crash recovery.
6. Carrier integration, real tracking events and proof-of-delivery evidence.
7. Persistent end-to-end pilot test, security review, operational runbooks and a controlled society rollout.

## Non-negotiable controls

- No real payment without a valid server-resolved payer identity, active mandate and amount within the approved limit.
- Human approval is required wherever the mandate/policy requires it; AI cannot grant itself authority.
- Never trust model-generated supplier identity, bank details, payment status, order acceptance, tracking status or delivery evidence.
- Never expose resident PII to suppliers; disclose only minimum anonymized procurement and delivery details.
- Use persistent idempotency and reconciliation across restarts and concurrent workers; in-memory maps are not a production durability boundary.
- Test duplicate requests, webhook replay, timeouts with unknown payment outcomes, supplier rejection, partial fulfillment, substitutions, quantity/price variance, refunds and failed delivery.

## Pilot exit criteria

A real transaction is complete only when Relay can show the original request, verified supplier record, supplier-originated quote, accepted PO reference, gateway-originated payment evidence, carrier-originated tracking events, proof of delivery, invoice/quantity/payment reconciliation and an immutable audit trail. Each piece of evidence must be traceable to its source and timestamp.
