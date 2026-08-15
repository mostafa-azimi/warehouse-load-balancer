# Warehouse Load Balancer

A Vercel-ready Next.js application for 3PL inventory balancing across ShipHero warehouses. It connects strictly through ShipHero's Public GraphQL API—there is no ShipHero AI dependency. It analyzes 60, 90, or 120 days of shipped line items, expands kit parents into their physical components, compares warehouse demand with current available inventory, and recommends inventory transfers.

## What is included

- Eligible-client dropdown showing the client account number and plain-text name
- Server-side ShipHero GraphQL integration with 3PL `customer_account_id` scoping
- Shipment, inventory, and kit-definition pagination
- Kit-component-aware demand calculation
- Demand-share inventory balancing across two or more warehouses
- Reviewable transfer recommendations with confidence, coverage, and rationale
- Approval flow that generates paired sales-order and purchase-order drafts
- Demo mode that works without credentials

Live order and purchase-order mutations are intentionally disabled in this MVP. The approval endpoint is already separated so a validated ShipHero write adapter can replace preview generation without changing the UI or analysis engine.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). With no environment variables, the app runs in demo mode.

## ShipHero configuration

Copy `.env.example` to `.env.local` and set:

```text
SHIPHERO_ACCESS_TOKEN=your_server_side_token
ALLOWED_CUSTOMER_ACCOUNT_IDS=10001=Example Client,10002=Another Client
SHIPHERO_WRITE_MODE=preview
```

`ALLOWED_CUSTOMER_ACCOUNT_IDS` is mandatory in live mode. It accepts either ShipHero public API IDs or numeric account numbers. Use `account=name` to override the dropdown's plain-text display name. If it is empty, no customer accounts are exposed. Never prefix a server secret with `NEXT_PUBLIC_`.

## Deploy to Vercel

1. Import the GitHub repository in Vercel.
2. Add the environment variables above to the Vercel project.
3. Deploy. Vercel detects Next.js automatically.

Long-running 120-day analysis may eventually be better served by a background job plus cached snapshots. The current implementation paginates live GraphQL reads inside a request and is intended as an analysis-first MVP.

## Balancing model

For each physical SKU, the engine:

1. Expands shipped kit parents into component demand.
2. Totals shipped component units by warehouse.
3. Calculates each warehouse's share of demand.
4. Applies that demand share to total currently available inventory.
5. Recommends transfers from warehouses above their target to those below it.

Transfers under four units are suppressed to avoid operational noise. The threshold and future safety-stock controls can be moved into per-client settings.
