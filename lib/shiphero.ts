import type {
  AnalysisInput,
  ClientAccount,
  InventoryRecord,
  KitDefinition,
  ShipmentLine,
  Warehouse,
} from "./types";
import { getShipHeroAccessToken } from "./shiphero-token-store";

const ENDPOINT = "https://public-api.shiphero.com/graphql";
// 25 shipments x up to 100 nested line items stays below ShipHero's 4,004-credit cap.
const PAGE_SIZE = 25;

type GraphQLError = { message: string; code?: number };

async function request<T>(query: string, variables: Record<string, unknown>) {
  const token = await getShipHeroAccessToken();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`ShipHero returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: T;
    errors?: GraphQLError[];
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
  if (!payload.data) throw new Error("ShipHero returned no data");
  return payload.data;
}

export function isLiveMode() {
  return Boolean(process.env.SHIPHERO_ACCESS_TOKEN);
}

export async function listLiveClients(): Promise<ClientAccount[]> {
  const data = await request<{
    account: {
      data: {
        customers: {
          edges: Array<{ node: { id: string; legacy_id: number; username: string; email: string; warehouse_relationship: { from_name: string } | null } }>;
        };
      };
    };
  }>(
    `query EligibleCustomers {
      account {
        request_id complexity
        data {
          customers(first: 100) {
            edges { node { id legacy_id username email warehouse_relationship { from_name } } }
          }
        }
      }
    }`,
    {},
  );
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
  if (!allowed.size) return [];
  return data.account.data.customers.edges
    .map(({ node }) => {
      const accountNumber = String(node.legacy_id);
      const configuredName = allowed.get(node.id) || allowed.get(accountNumber);
      return {
        id: node.id,
        accountNumber,
        name:
          configuredName ||
          node.warehouse_relationship?.from_name ||
          node.email ||
          node.username ||
          `Account ${node.legacy_id}`,
      };
    })
    .filter(
      (client) => allowed.has(client.id) || allowed.has(client.accountNumber),
    );
}

type Connection<T> = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  edges: Array<{ node: T }>;
};

async function paginate<T>(
  fetchPage: (after: string | null) => Promise<Connection<T>>,
) {
  const rows: T[] = [];
  let after: string | null = null;
  do {
    const page = await fetchPage(after);
    rows.push(...page.edges.map((edge) => edge.node));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return rows;
}

export async function getLiveAnalysisInput(
  client: ClientAccount,
  lookbackDays: 60 | 90 | 120,
): Promise<AnalysisInput> {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 86_400_000);
  const variables = {
    customerAccountId: client.id,
    from: from.toISOString(),
    to: to.toISOString(),
  };

  const [shipmentRows, inventoryRows, productRows] = await Promise.all([
    paginate(async (after) => {
      const data = await request<{
        shipments: { data: Connection<{ warehouse_id: string; line_items: { edges: Array<{ node: { quantity: number; line_item: { sku: string } } }> } }> };
      }>(
        `query ShippedDemand($customerAccountId: String!, $from: ISODateTime!, $to: ISODateTime!, $after: String) {
          shipments(customer_account_id: $customerAccountId, date_from: $from, date_to: $to, voided: false) {
            request_id complexity
            data(first: ${PAGE_SIZE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { warehouse_id line_items(first: 100) { edges { node { quantity line_item { sku } } } } } }
            }
          }
        }`,
        { ...variables, after },
      );
      return data.shipments.data;
    }),
    paginate(async (after) => {
      const data = await request<{
        warehouse_products: { data: Connection<{ sku: string; available: number; on_hand: number; allocated: number; warehouse_id: string; warehouse: { id: string; identifier: string; address: { name: string } }; product: { name: string } }> };
      }>(
        `query CurrentInventory($customerAccountId: String!, $after: String) {
          warehouse_products(customer_account_id: $customerAccountId, active: true) {
            request_id complexity
            data(first: ${PAGE_SIZE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { sku available on_hand allocated warehouse_id warehouse { id identifier address { name } } product { name } } }
            }
          }
        }`,
        { customerAccountId: client.id, after },
      );
      return data.warehouse_products.data;
    }),
    paginate(async (after) => {
      const data = await request<{
        products: { data: Connection<{ sku: string; kit_components: Array<{ sku: string; quantity: number }> }> };
      }>(
        `query KitDefinitions($customerAccountId: String!, $after: String) {
          products(customer_account_id: $customerAccountId, has_kits: true) {
            request_id complexity
            data(first: ${PAGE_SIZE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { sku kit_components { sku quantity } } }
            }
          }
        }`,
        { customerAccountId: client.id, after },
      );
      return data.products.data;
    }),
  ]);

  const warehouseMap = new Map<string, Warehouse>();
  const inventory: InventoryRecord[] = inventoryRows.map((row) => {
    warehouseMap.set(row.warehouse_id, {
      id: row.warehouse_id,
      code: row.warehouse.identifier,
      name: row.warehouse.address?.name || row.warehouse.identifier,
    });
    return {
      sku: row.sku,
      productName: row.product?.name || row.sku,
      warehouseId: row.warehouse_id,
      available: row.available,
      onHand: row.on_hand,
      allocated: row.allocated,
    };
  });
  const shipments: ShipmentLine[] = shipmentRows.flatMap((shipment) =>
    shipment.line_items.edges.map(({ node }) => ({
      sku: node.line_item.sku,
      quantity: node.quantity,
      warehouseId: shipment.warehouse_id,
    })),
  );
  const kits: KitDefinition[] = productRows.map((product) => ({
    sku: product.sku,
    components: product.kit_components,
  }));

  return {
    client,
    warehouses: [...warehouseMap.values()],
    shipments,
    inventory,
    kits,
    lookbackDays,
    mode: "live",
  };
}
