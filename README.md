# Warehouse Load Balancer

A Vercel-ready Next.js application for 3PL inventory balancing across ShipHero warehouses. It reads analysis data from ShipHero's paid SQL data export and uses the Public GraphQL API for OAuth maintenance and future approved writes. There is no ShipHero AI dependency. It analyzes 60, 90, or 120 days of shipped line items, expands kit parents into their physical components, compares warehouse demand with current available inventory, and recommends inventory transfers.

## What is included

- Eligible-client dropdown showing the client account number and plain-text name
- Server-side, read-only ShipHero/ShipBots SQL export integration
- Public GraphQL API fallback when the SQL export is not configured
- Kit-component-aware demand calculation
- Exclusion of orders marked as FBA, wholesale, or transfer activity
- Explicit exclusion of shipments between Gardena/Primary and Atlanta
- 14-day SKU activity checks with inactive and slowing-demand warnings
- Optional OpenAI or Anthropic review configured through a protected settings page
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

## Data export configuration

Copy `.env.example` to `.env.local` and set:

```text
SHIPBOTS_SQL_SERVER=your_export_host
SHIPBOTS_SQL_PORT=5500
SHIPBOTS_SQL_DATABASE=sbsql
SHIPBOTS_SQL_USER=your_read_only_user
SHIPBOTS_SQL_PASSWORD=your_read_only_password
SHIPBOTS_SQL_ENCRYPT=false
ALLOWED_CUSTOMER_ACCOUNT_IDS=10001=Example Client,10002=Another Client
```

The SQL credentials are server-only. The app queries shipped line items, current warehouse inventory, and kit/assembly mappings directly from the six-hourly export. It does not copy customer order history into Redis or Supabase. Redis only caches completed analysis results for ten minutes and coordinates concurrent runs.

The demand query excludes orders identified by FBA/Amazon tags or destination fields, transfer or wholesale markers, and shipments on the known Gardena/Primary↔Atlanta internal route. The UI reports excluded order and unit counts with the signals that caused each exclusion. It does not exclude an order solely because it is large.

When the SQL export is configured, it is the preferred analysis source. If it is not configured, the app can use the Public GraphQL API with:

```text
SHIPHERO_ACCESS_TOKEN=your_server_side_token
SHIPHERO_REFRESH_TOKEN=your_server_side_refresh_token
SHIPHERO_CLIENT_ID=your_oauth_client_id
SHIPHERO_WRITE_MODE=preview
CRON_SECRET=use_a_password_manager_generated_value
```

`ALLOWED_CUSTOMER_ACCOUNT_IDS` is mandatory in live mode. It accepts either ShipHero public API IDs or numeric account numbers. Use `account=name` to override the dropdown's plain-text display name. If it is empty, no customer accounts are exposed. Never prefix a server secret with `NEXT_PUBLIC_`.

## Automatic token rotation

The app stores the active ShipHero OAuth token pair in Upstash Redis. A secured Vercel Cron runs daily and refreshes the pair after 25 days or when fewer than three days remain before access-token expiry, whichever happens first. Application requests use the Redis-backed token and opportunistically refresh near expiry as a second safety net.

The Redis integration injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`. `CRON_SECRET` is required so Vercel can authenticate calls to `/api/cron/refresh-shiphero`. Tokens and token values are never returned by that route or written to logs.

## Deploy to Vercel

1. Import the GitHub repository in Vercel.
2. Add the environment variables above to the Vercel project.
3. Deploy. Vercel detects Next.js automatically.

The deployed application prefers the SQL export, so analysis no longer burns ShipHero API pagination credits. The Public API path remains available if the export settings are removed.

## Optional AI review

Set `AI_SETTINGS_ENCRYPTION_KEY` and `AI_SETTINGS_ADMIN_PASSWORD` on the server, then open `/settings`. The administrator can save either an OpenAI or Anthropic API key and model ID. The provider key is encrypted with AES-256-GCM before it is stored in Redis and is never returned to the browser. AI requests require the administrator password and are rate-limited. Only aggregated SKU, inventory, demand, warehouse, and exclusion data is sent; order-level customer information is not sent.

AI is an optional second opinion. The transfer quantities and exclusions remain deterministic, reviewable application logic.

## Balancing model

For each physical SKU, the engine:

1. Expands shipped kit parents into component demand.
2. Excludes orders identified by status or tags as FBA, wholesale, or transfer activity.
3. Excludes known Gardena/Primary↔Atlanta internal shipments.
4. Checks the last 14 days to flag inactive or sharply slowing SKUs.
5. Totals shipped component units by warehouse.
6. Calculates each warehouse's share of demand.
7. Applies that demand share to total currently available inventory.
8. Recommends transfers from warehouses above their target to those below it.

Transfers under four units are suppressed to avoid operational noise. The threshold and future safety-stock controls can be moved into per-client settings.
