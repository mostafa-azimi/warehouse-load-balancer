import sql from "mssql";
import type {
  AnalysisInput,
  ClientAccount,
  ExclusionSummary,
  InventoryRecord,
  KitDefinition,
  ShipmentLine,
  Warehouse,
} from "./types";

declare global {
  var shipbotsSqlPool: Promise<sql.ConnectionPool> | undefined;
}

export function shipbotsSqlConfigured() {
  return Boolean(
    process.env.SHIPBOTS_SQL_SERVER &&
      process.env.SHIPBOTS_SQL_DATABASE &&
      process.env.SHIPBOTS_SQL_USER &&
      process.env.SHIPBOTS_SQL_PASSWORD,
  );
}

function connectionPool() {
  if (!shipbotsSqlConfigured()) {
    throw new Error("The ShipBots SQL export is not configured");
  }
  if (!global.shipbotsSqlPool) {
    global.shipbotsSqlPool = new sql.ConnectionPool({
      server: process.env.SHIPBOTS_SQL_SERVER!,
      port: Number(process.env.SHIPBOTS_SQL_PORT ?? 1433),
      database: process.env.SHIPBOTS_SQL_DATABASE!,
      user: process.env.SHIPBOTS_SQL_USER!,
      password: process.env.SHIPBOTS_SQL_PASSWORD!,
      connectionTimeout: 15_000,
      requestTimeout: 120_000,
      pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
      options: {
        encrypt: process.env.SHIPBOTS_SQL_ENCRYPT === "true",
        trustServerCertificate: true,
      },
    }).connect();
    global.shipbotsSqlPool.catch(() => {
      global.shipbotsSqlPool = undefined;
    });
  }
  return global.shipbotsSqlPool;
}

type DemandRow = {
  order_id: string;
  warehouse_id: string;
  sku: string;
  quantity: number;
  recent_quantity: number;
  field_category: ExclusionSummary["category"] | null;
  field_signal: string | null;
};

type TagMarkerRow = {
  order_id: string;
  category: ExclusionSummary["category"];
  signal: string;
};

type InventoryRow = {
  warehouse_id: string;
  warehouse_name: string;
  sku: string;
  product_name: string;
  on_hand: number;
  allocated: number;
  available: number;
  data_as_of: Date | string;
};

type KitRow = {
  sku: string;
  component_sku: string;
  quantity: number;
};

type ClientRow = {
  account_number: string;
  name: string | null;
};

export async function getShipbotsClientAccessStatus() {
  const pool = await connectionPool();
  const result = await pool.request().query<ClientRow>(`
    SELECT
      CONVERT(varchar(50), CONVERT(bigint, customer_id)) AS account_number,
      MAX(NULLIF(from_name, '')) AS name
    FROM dbo.de_warehouse_to_customers
    GROUP BY CONVERT(varchar(50), CONVERT(bigint, customer_id));
  `);
  const allowed = new Map(
    (process.env.ALLOWED_CUSTOMER_ACCOUNT_IDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return separator === -1
          ? [entry, ""]
          : [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
      }),
  );
  const clients: ClientAccount[] = result.recordset
    .filter((row) => allowed.has(row.account_number))
    .map((row) => ({
      id: row.account_number,
      accountNumber: row.account_number,
      name:
        allowed.get(row.account_number) ||
        row.name ||
        `Account ${row.account_number}`,
    }));
  return {
    clients,
    accessibleCustomerCount: result.recordset.length,
    eligibleCustomerCount: clients.length,
  };
}

const INTERNAL_ROUTE_PREDICATE = `
  (
    UPPER(COALESCE(s.warehouse, '')) LIKE '%ATLANTA%'
    AND UPPER(COALESCE(o.city, '')) LIKE '%GARDENA%'
  ) OR (
    (
      UPPER(COALESCE(s.warehouse, '')) LIKE '%GARDENA%'
      OR UPPER(COALESCE(s.warehouse, '')) LIKE '%PRIMARY%'
    )
    AND UPPER(COALESCE(o.city, '')) LIKE '%ATLANTA%'
  )
`;

const FBA_FIELD_PREDICATE = `
  UPPER(COALESCE(o.fulfillment_status, '')) LIKE '%FBA%'
  OR UPPER(COALESCE(o.source, '')) LIKE '%FBA%'
  OR UPPER(COALESCE(o.shipping_name, '')) LIKE '%FBA%'
  OR UPPER(COALESCE(o.company, '')) LIKE '%AMAZON%'
  OR UPPER(COALESCE(o.comments, '')) LIKE '%FBA%'
  OR UPPER(COALESCE(o.customer_note, '')) LIKE '%FBA%'
`;

const RAW_DEMAND_QUERY = `
  WITH scoped_shipments AS (
    SELECT
      s.id AS shipment_id,
      s.warehouse_id,
      s.created_date,
      o.id AS order_id,
      classification.category AS field_category,
      CASE
        WHEN classification.category = 'internal-transfer' AND
          UPPER(COALESCE(s.warehouse, '')) LIKE '%ATLANTA%'
          AND UPPER(COALESCE(o.city, '')) LIKE '%GARDENA%'
          THEN 'Atlanta to Gardena route'
        WHEN classification.category = 'internal-transfer' AND (
          UPPER(COALESCE(s.warehouse, '')) LIKE '%GARDENA%'
          OR UPPER(COALESCE(s.warehouse, '')) LIKE '%PRIMARY%'
        ) AND UPPER(COALESCE(o.city, '')) LIKE '%ATLANTA%'
          THEN 'Gardena to Atlanta route'
        WHEN classification.category = 'internal-transfer' THEN 'Transfer fulfillment status'
        WHEN classification.category = 'fba'
          AND UPPER(COALESCE(o.company, '')) LIKE '%AMAZON%'
          THEN 'Amazon destination company'
        WHEN classification.category = 'fba' THEN 'FBA order field'
        WHEN classification.category = 'wholesale' THEN 'Wholesale marker'
        ELSE NULL
      END AS field_signal
    FROM dbo.de_shipments s
    JOIN dbo.de_orders o ON o.id = CONVERT(bigint, s.order_id)
    CROSS APPLY (
      SELECT CASE
        WHEN ${INTERNAL_ROUTE_PREDICATE}
          OR UPPER(COALESCE(o.fulfillment_status, '')) LIKE '%TRANSFER%'
          THEN 'internal-transfer'
        WHEN ${FBA_FIELD_PREDICATE} THEN 'fba'
        WHEN UPPER(COALESCE(o.fulfillment_status, '')) LIKE '%WHOLESALE%'
          THEN 'wholesale'
        ELSE NULL
      END AS category
    ) classification
    WHERE o.account_id = @accountId
      AND s.created_date >= DATEADD(day, -@lookbackDays, SYSUTCDATETIME())
      AND s.completed = 1
      AND s.status = 'valid'
      AND LOWER(COALESCE(o.fulfillment_status, '')) NOT IN
        ('canceled', 'cancelled', 'refunded', 'failed')
  )
  SELECT
    CONVERT(varchar(50), shipments.order_id) AS order_id,
    CONVERT(varchar(50), CONVERT(bigint, shipments.warehouse_id)) AS warehouse_id,
    LTRIM(RTRIM(li.sku)) AS sku,
    SUM(CONVERT(float, sli.quantity)) AS quantity,
    SUM(CASE WHEN shipments.created_date >= DATEADD(day, -14, SYSUTCDATETIME())
      THEN CONVERT(float, sli.quantity) ELSE 0 END) AS recent_quantity,
    shipments.field_category,
    shipments.field_signal
  FROM scoped_shipments shipments
  JOIN dbo.de_shipped_line_items sli
    ON CONVERT(bigint, sli.shipment_id) = shipments.shipment_id
  JOIN dbo.de_line_items li
    ON li.id = CONVERT(bigint, sli.line_item_id)
  WHERE NULLIF(LTRIM(RTRIM(li.sku)), '') IS NOT NULL
  GROUP BY shipments.order_id, shipments.warehouse_id, LTRIM(RTRIM(li.sku)),
    shipments.field_category, shipments.field_signal;
`;

const TAG_MARKERS_QUERY = `
  WITH scoped_orders AS (
    SELECT DISTINCT o.id
    FROM dbo.de_orders o
    JOIN dbo.de_shipments s ON CONVERT(bigint, s.order_id) = o.id
    WHERE o.account_id = @accountId
      AND s.created_date >= DATEADD(day, -@lookbackDays, SYSUTCDATETIME())
      AND s.completed = 1
      AND s.status = 'valid'
  ), tag_flags AS (
    SELECT
      scoped_orders.id AS order_id,
      MAX(CASE WHEN UPPER(COALESCE(tags.value, '')) LIKE '%FBA%'
        OR UPPER(COALESCE(tags.value, '')) LIKE '%AMAZON%' THEN 1 ELSE 0 END) AS is_fba,
      MAX(CASE WHEN UPPER(COALESCE(tags.value, '')) LIKE '%TRANSFER%' THEN 1 ELSE 0 END) AS is_transfer,
      MAX(CASE WHEN UPPER(COALESCE(tags.value, '')) LIKE '%WHOLESALE%' THEN 1 ELSE 0 END) AS is_wholesale
    FROM scoped_orders
    JOIN dbo.de_order_tags tags ON tags.order_id = scoped_orders.id
    WHERE UPPER(COALESCE(tags.value, '')) LIKE '%FBA%'
      OR UPPER(COALESCE(tags.value, '')) LIKE '%AMAZON%'
      OR UPPER(COALESCE(tags.value, '')) LIKE '%TRANSFER%'
      OR UPPER(COALESCE(tags.value, '')) LIKE '%WHOLESALE%'
    GROUP BY scoped_orders.id
  )
  SELECT
    CONVERT(varchar(50), order_id) AS order_id,
    CASE
      WHEN is_transfer = 1 THEN 'internal-transfer'
      WHEN is_fba = 1 THEN 'fba'
      ELSE 'wholesale'
    END AS category,
    CASE
      WHEN is_transfer = 1 THEN 'Transfer order tag'
      WHEN is_fba = 1 THEN 'FBA/Amazon order tag'
      ELSE 'Wholesale order tag'
    END AS signal
  FROM tag_flags;
`;

const INVENTORY_QUERY = `
  WITH product_names AS (
    SELECT account_id, sku, MAX(NULLIF(name, '')) AS product_name
    FROM dbo.de_products
    WHERE account_id = @accountId
    GROUP BY account_id, sku
  )
  SELECT
    CONVERT(varchar(50), CONVERT(bigint, wp.warehouse_id)) AS warehouse_id,
    COALESCE(NULLIF(wp.warehouse, ''), 'Warehouse') AS warehouse_name,
    LTRIM(RTRIM(wp.sku)) AS sku,
    COALESCE(p.product_name, wp.sku) AS product_name,
    CONVERT(float, COALESCE(wp.on_hand, 0)) AS on_hand,
    CONVERT(float, COALESCE(wp.allocated, 0)) AS allocated,
    CONVERT(float, COALESCE(wp.on_hand, 0) - COALESCE(wp.allocated, 0)) AS available,
    MAX(wp.updated_at) OVER () AS data_as_of
  FROM dbo.de_warehouse_products wp
  LEFT JOIN product_names p
    ON p.account_id = wp.account_id AND p.sku = wp.sku
  WHERE wp.account_id = @accountId
    AND wp.active = 1
    AND NULLIF(LTRIM(RTRIM(wp.sku)), '') IS NOT NULL;
`;

const KITS_QUERY = `
  SELECT DISTINCT
    LTRIM(RTRIM(sku)) AS sku,
    LTRIM(RTRIM(component_sku)) AS component_sku,
    CONVERT(float, quantity) AS quantity
  FROM (
    SELECT account_id, sku, component_sku, quantity
    FROM dbo.de_kitting_map
    UNION ALL
    SELECT account_id, sku, component_sku, quantity
    FROM dbo.de_assembly_map
  ) maps
  WHERE account_id = @accountId
    AND NULLIF(LTRIM(RTRIM(sku)), '') IS NOT NULL
    AND NULLIF(LTRIM(RTRIM(component_sku)), '') IS NOT NULL
    AND quantity > 0;
`;

export async function getShipbotsAnalysisInput(
  client: ClientAccount,
  lookbackDays: 60 | 90 | 120,
): Promise<AnalysisInput> {
  const accountId = Number(client.accountNumber);
  if (!Number.isSafeInteger(accountId)) {
    throw new Error(`Invalid numeric client account: ${client.accountNumber}`);
  }

  const pool = await connectionPool();
  const request = () =>
    pool
      .request()
      .input("accountId", sql.Decimal(18, 4), accountId)
      .input("lookbackDays", sql.Int, lookbackDays);

  const [demandResult, tagResult, inventoryResult, kitsResult] = await Promise.all([
    request().query<DemandRow>(RAW_DEMAND_QUERY),
    request().query<TagMarkerRow>(TAG_MARKERS_QUERY),
    request().query<InventoryRow>(INVENTORY_QUERY),
    request().query<KitRow>(KITS_QUERY),
  ]);

  const warehouseMap = new Map<string, Warehouse>();
  const inventory: InventoryRecord[] = inventoryResult.recordset.map((row) => {
    warehouseMap.set(row.warehouse_id, {
      id: row.warehouse_id,
      code: row.warehouse_name,
      name: row.warehouse_name,
    });
    return {
      sku: row.sku,
      productName: row.product_name,
      warehouseId: row.warehouse_id,
      available: row.available,
      onHand: row.on_hand,
      allocated: row.allocated,
    };
  });

  const tagMarkers = new Map(tagResult.recordset.map((row) => [row.order_id, row]));
  const categoryRank: Record<ExclusionSummary["category"], number> = {
    "internal-transfer": 3,
    fba: 2,
    wholesale: 1,
  };
  const includedDemand = new Map<string, ShipmentLine>();
  const excluded = new Map<ExclusionSummary["category"], {
    orders: Set<string>;
    units: number;
    signals: Set<string>;
  }>();

  for (const row of demandResult.recordset) {
    const fieldMarker = row.field_category
      ? { category: row.field_category, signal: row.field_signal ?? "Order field marker" }
      : null;
    const tagMarker = tagMarkers.get(row.order_id) ?? null;
    const marker = tagMarker && (!fieldMarker || categoryRank[tagMarker.category] > categoryRank[fieldMarker.category])
      ? tagMarker
      : fieldMarker;

    if (marker) {
      const summary = excluded.get(marker.category) ?? {
        orders: new Set<string>(),
        units: 0,
        signals: new Set<string>(),
      };
      summary.orders.add(row.order_id);
      summary.units += Number(row.quantity);
      summary.signals.add(marker.signal);
      excluded.set(marker.category, summary);
      continue;
    }

    const demandKey = `${row.sku.trim().toUpperCase()}::${row.warehouse_id}`;
    const current = includedDemand.get(demandKey) ?? {
      sku: row.sku,
      quantity: 0,
      warehouseId: row.warehouse_id,
      recentQuantity: 0,
    };
    current.quantity += Number(row.quantity);
    current.recentQuantity = (current.recentQuantity ?? 0) + Number(row.recent_quantity);
    includedDemand.set(demandKey, current);
  }
  const shipments = [...includedDemand.values()];

  const kitMap = new Map<string, KitDefinition>();
  for (const row of kitsResult.recordset) {
    const kit = kitMap.get(row.sku) ?? { sku: row.sku, components: [] };
    kit.components.push({ sku: row.component_sku, quantity: row.quantity });
    kitMap.set(row.sku, kit);
  }

  const dataAsOf = inventoryResult.recordset[0]?.data_as_of;
  return {
    client,
    warehouses: [...warehouseMap.values()],
    shipments,
    inventory,
    kits: [...kitMap.values()],
    lookbackDays,
    mode: "live",
    dataSource: "shipbots-export",
    dataAsOf: dataAsOf ? new Date(dataAsOf).toISOString() : undefined,
    exclusions: [...excluded.entries()].map(([category, summary]) => ({
      category,
      orders: summary.orders.size,
      units: summary.units,
      signals: [...summary.signals],
    })),
  };
}
