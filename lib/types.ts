export type ClientAccount = {
  id: string;
  accountNumber: string;
  name: string;
};

export type Warehouse = { id: string; name: string; code: string };

export type ShipmentLine = {
  sku: string;
  quantity: number;
  warehouseId: string;
};

export type InventoryRecord = {
  sku: string;
  productName: string;
  warehouseId: string;
  available: number;
  onHand: number;
  allocated: number;
};

export type KitDefinition = {
  sku: string;
  components: Array<{ sku: string; quantity: number }>;
};

export type Recommendation = {
  id: string;
  sku: string;
  productName: string;
  fromWarehouse: Warehouse;
  toWarehouse: Warehouse;
  quantity: number;
  fromAvailable: number;
  toAvailable: number;
  fromDemand: number;
  toDemand: number;
  projectedFromDays: number | null;
  projectedToDays: number | null;
  confidence: "High" | "Medium" | "Low";
  reason: string;
  kitSources: string[];
};

export type AnalysisResult = {
  generatedAt: string;
  mode: "demo" | "live";
  lookbackDays: 60 | 90 | 120;
  client: ClientAccount;
  warehouses: Warehouse[];
  metrics: {
    shippedUnits: number;
    componentUnits: number;
    activeSkus: number;
    recommendedUnits: number;
    estimatedCoverageGainDays: number;
  };
  recommendations: Recommendation[];
  dataSource?: "shiphero-api" | "shipbots-export";
  dataAsOf?: string;
};

export type AnalysisInput = {
  client: ClientAccount;
  warehouses: Warehouse[];
  shipments: ShipmentLine[];
  inventory: InventoryRecord[];
  kits: KitDefinition[];
  lookbackDays: 60 | 90 | 120;
  mode: "demo" | "live";
  dataSource?: "shiphero-api" | "shipbots-export";
  dataAsOf?: string;
};
