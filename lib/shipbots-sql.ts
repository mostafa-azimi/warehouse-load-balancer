import sql from "mssql";
import type {
  AnalysisInput,
  ClientAccount,
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
  warehouse_id: string;
  sku: string;
  quantity: number;
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

const DEMAND_QUERY = `
  SELECT
    CONVERT(varchar(50), CONVERT(bigint, s.warehouse_id)) AS warehouse_id,
    LTRIM(RTRIM(li.sku)) AS sku,
    SUM(CONVERT(float, sli.quantity)) AS quantity
  FROM dbo.de_shipped_line_items sli
  JOIN dbo.de_shipments s
    ON s.id = CONVERT(bigint, sli.shipment_id)
  JOIN dbo.de_orders o
    ON o.id = CONVERT(bigint, s.order_id)
  JOIN dbo.de_line_items li
    ON li.id = CONVERT(bigint, sli.line_item_id)
  WHERE o.account_id = @accountId
    AND s.created_date >= DATEADD(day, -@lookbackDays, SYSUTCDATETIME())
    AND s.completed = 1
    AND s.status = 'valid'
    AND NULLIF(LTRIM(RTRIM(li.sku)), '') IS NOT NULL
    AND LOWER(COALESCE(o.fulfillment_status, '')) NOT IN
      ('canceled', 'cancelled', 'refunded', 'failed')
    AND UPPER(COALESCE(o.fulfillment_status, '')) NOT LIKE '%FBA%'
    AND UPPER(COALESCE(o.fulfillment_status, '')) NOT LIKE '%WHOLESALE%'
    AND UPPER(COALESCE(o.fulfillment_status, '')) NOT LIKE '%TRANSFER%'
    AND NOT EXISTS (
      SELECT 1
      FROM dbo.de_order_tags tags
      WHERE CONVERT(bigint, tags.order_id) = o.id
        AND (
          UPPER(COALESCE(tags.value, '')) LIKE '%FBA%'
          OR UPPER(COALESCE(tags.value, '')) LIKE '%WHOLESALE%'
          OR UPPER(COALESCE(tags.value, '')) LIKE '%TRANSFER%'
        )
    )
  GROUP BY
    CONVERT(varchar(50), CONVERT(bigint, s.warehouse_id)),
    LTRIM(RTRIM(li.sku));
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

  const [demandResult, inventoryResult, kitsResult] = await Promise.all([
    request().query<DemandRow>(DEMAND_QUERY),
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

  const shipments: ShipmentLine[] = demandResult.recordset.map((row) => ({
    sku: row.sku,
    quantity: row.quantity,
    warehouseId: row.warehouse_id,
  }));

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
  };
}
