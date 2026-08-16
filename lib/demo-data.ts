import type {
  AnalysisInput,
  ClientAccount,
  InventoryRecord,
  KitDefinition,
  ShipmentLine,
  Warehouse,
} from "./types";

export const demoClients: ClientAccount[] = [
  { id: "demo-acct-1042", accountNumber: "1042", name: "Juniper & Co." },
  { id: "demo-acct-2188", accountNumber: "2188", name: "Northline Goods" },
  { id: "demo-acct-3701", accountNumber: "3701", name: "Sundays Supply" },
];

const warehouses: Warehouse[] = [
  { id: "demo-atl", code: "ATL", name: "Atlanta, GA" },
  { id: "demo-lax", code: "LAX", name: "Los Angeles, CA" },
];

const inventory: InventoryRecord[] = [
  ["AERO-BTL-24", "Aero Bottle — 24 oz", 384, 42],
  ["CORE-TEE-BLK-M", "Core Tee — Black / M", 62, 296],
  ["TRAIL-CAP-GRN", "Trail Cap — Forest", 211, 35],
  ["DAYPACK-18L", "Daypack — 18L", 28, 122],
  ["SOCK-CRW-WHT", "Crew Sock — White", 178, 44],
  ["KIT-HYDRATE-BTL", "Hydrate Kit Bottle", 144, 26],
].flatMap(([sku, productName, atl, lax]) => [
  {
    sku: sku as string,
    productName: productName as string,
    warehouseId: "demo-atl",
    available: atl as number,
    onHand: (atl as number) + 18,
    allocated: 18,
  },
  {
    sku: sku as string,
    productName: productName as string,
    warehouseId: "demo-lax",
    available: lax as number,
    onHand: (lax as number) + 12,
    allocated: 12,
  },
]);

const demandPlan: Array<[string, number, number]> = [
  ["AERO-BTL-24", 54, 246],
  ["CORE-TEE-BLK-M", 228, 72],
  ["TRAIL-CAP-GRN", 38, 142],
  ["DAYPACK-18L", 112, 34],
  ["SOCK-CRW-WHT", 46, 154],
  ["KIT-HYDRATE", 18, 96],
];

const kits: KitDefinition[] = [
  {
    sku: "KIT-HYDRATE",
    components: [
      { sku: "KIT-HYDRATE-BTL", quantity: 1 },
      { sku: "SOCK-CRW-WHT", quantity: 2 },
    ],
  },
];

export function getDemoInput(
  clientId: string,
  lookbackDays: 60 | 90 | 120,
): AnalysisInput {
  const client = demoClients.find((item) => item.id === clientId) ?? demoClients[0];
  const multiplier = lookbackDays / 90;
  const shipments: ShipmentLine[] = demandPlan.flatMap(([sku, atl, lax]) => [
    { sku, quantity: Math.round(atl * multiplier), warehouseId: "demo-atl", recentQuantity: Math.max(1, Math.round((atl * 14) / 90)) },
    { sku, quantity: Math.round(lax * multiplier), warehouseId: "demo-lax", recentQuantity: Math.max(1, Math.round((lax * 14) / 90)) },
  ]);

  return {
    client,
    warehouses,
    shipments,
    inventory,
    kits,
    lookbackDays,
    mode: "demo",
  };
}
