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
// Keep estimated reservations modest because the 3PL credit pool is shared.
const PAGE_SIZE = 10;
const MAX_THROTTLE_ATTEMPTS = 6;

type GraphQLError = {
  message: string;
  code?: number;
  extensions?: { code?: number; time_remaining?: string };
};

type CustomerNode = {
  id: string;
  legacy_id: number;
  username: string;
  email: string;
  warehouse_relationship: { from_name: string } | null;
};

async function request<T>(query: string, variables: Record<string, unknown>) {
  for (let attempt = 0; attempt < MAX_THROTTLE_ATTEMPTS; attempt += 1) {
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
    const payload = (await response.json()) as {
      data?: T;
      errors?: GraphQLError[];
    };
    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message).join("; ");
      const throttled = payload.errors.some(
        (error) =>
          error.code === 30 ||
          error.extensions?.code === 30 ||
          /not enough credits|throttl/i.test(error.message),
      );
      const waitText =
        payload.errors.find((error) => error.extensions?.time_remaining)
          ?.extensions?.time_remaining ?? message;
      const seconds = Number(waitText.match(/(\d+)\s*seconds?/i)?.[1] ?? 0);
      const minutes = Number(waitText.match(/(\d+)\s*minutes?/i)?.[1] ?? 0);
      const waitMs = (minutes * 60 + seconds) * 1_000;
      if (
        throttled &&
        attempt < MAX_THROTTLE_ATTEMPTS - 1 &&
        waitMs > 0 &&
        waitMs <= 60_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, waitMs + 1_000));
        continue;
      }
      throw new Error(message);
    }
    if (!response.ok) throw new Error(`ShipHero returned HTTP ${response.status}`);
    if (!payload.data) throw new Error("ShipHero returned no data");
    return payload.data;
  }
  throw new Error("ShipHero request failed after throttling retries");
}

export function isLiveMode() {
  return Boolean(process.env.SHIPHERO_ACCESS_TOKEN);
}

async function fetchAccessibleCustomers(): Promise<CustomerNode[]> {
  return paginate(async (after) => {
    const data = await request<{
      account: {
        request_id?: string;
        data: {
          customers: Connection<CustomerNode>;
        } | null;
      };
    }>(
      `query EligibleCustomers($after: String) {
        account {
          request_id complexity
          data {
            customers(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { id legacy_id username email warehouse_relationship { from_name } } }
            }
          }
        }
      }`,
      { after },
    );

    if (!data.account.data) {
      throw new Error(
        `ShipHero account query returned no data${data.account.request_id ? ` [request ${data.account.request_id}]` : ""}`,
      );
    }
    return data.account.data.customers;
  });
}

function allowedCustomers(nodes: CustomerNode[]) {
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
  return nodes
    .map((node) => {
      const legacyAccountNumber = String(node.legacy_id);
      const accountNumber = /^\d+$/.test(node.username?.trim())
        ? node.username.trim()
        : legacyAccountNumber;
      const configuredName =
        allowed.get(node.id) ||
        allowed.get(accountNumber) ||
        allowed.get(legacyAccountNumber);
      return {
        id: node.id,
        accountNumber,
        legacyAccountNumber,
        name:
          configuredName ||
          node.warehouse_relationship?.from_name ||
          node.email ||
          node.username ||
          `Account ${node.legacy_id}`,
      };
    })
    .filter(
      (client) =>
        allowed.has(client.id) ||
        allowed.has(client.accountNumber) ||
        allowed.has(client.legacyAccountNumber),
    )
    .map((client) => ({
      id: client.id,
      accountNumber: client.accountNumber,
      name: client.name,
    }));
}

export async function getLiveClientAccessStatus() {
  const accessibleCustomers = await fetchAccessibleCustomers();
  const clients = allowedCustomers(accessibleCustomers);
  return {
    clients,
    accessibleCustomerCount: accessibleCustomers.length,
    eligibleCustomerCount: clients.length,
  };
}

export async function listLiveClients(): Promise<ClientAccount[]> {
  return (await getLiveClientAccessStatus()).clients;
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

  // Run these credit-heavy connections sequentially. Concurrent requests reserve
  // their estimated complexity at the same time and can exhaust a shared 3PL pool.
  const shipmentRows = await paginate(async (after) => {
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
  });
  const inventoryRows = await paginate(async (after) => {
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
  });
  const productRows = await paginate(async (after) => {
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
  });

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
