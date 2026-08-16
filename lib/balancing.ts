import type {
  AnalysisInput,
  AnalysisResult,
  Recommendation,
  ShipmentLine,
} from "./types";

const MIN_TRANSFER = 4;

const key = (sku: string, warehouseId: string) =>
  `${sku.trim().toUpperCase()}::${warehouseId}`;

export function expandKits(
  shipments: ShipmentLine[],
  kits: AnalysisInput["kits"],
) {
  const kitMap = new Map(kits.map((kit) => [kit.sku.toUpperCase(), kit]));
  const kitSources = new Map<string, Set<string>>();
  const expanded: ShipmentLine[] = [];

  for (const line of shipments) {
    const normalizedSku = line.sku.trim().toUpperCase();
    const kit = kitMap.get(normalizedSku);
    if (!kit) {
      expanded.push({ ...line, sku: normalizedSku });
      continue;
    }

    for (const component of kit.components) {
      const componentSku = component.sku.trim().toUpperCase();
      expanded.push({
        sku: componentSku,
        quantity: line.quantity * component.quantity,
        warehouseId: line.warehouseId,
        ...(typeof line.recentQuantity === "number"
          ? { recentQuantity: line.recentQuantity * component.quantity }
          : {}),
      });
      const sourceKey = key(componentSku, line.warehouseId);
      const sources = kitSources.get(sourceKey) ?? new Set<string>();
      sources.add(normalizedSku);
      kitSources.set(sourceKey, sources);
    }
  }

  return { expanded, kitSources };
}

const daysOfCover = (available: number, demand: number, lookbackDays: number) => {
  if (demand === 0) return null;
  return Math.round((available / (demand / lookbackDays)) * 10) / 10;
};

export function buildAnalysis(input: AnalysisInput): AnalysisResult {
  const { expanded, kitSources } = expandKits(input.shipments, input.kits);
  const demand = new Map<string, number>();
  const recentDemand = new Map<string, number>();
  const hasRecencyData = expanded.some(
    (line) => typeof line.recentQuantity === "number",
  );
  for (const line of expanded) {
    const demandKey = key(line.sku, line.warehouseId);
    demand.set(demandKey, (demand.get(demandKey) ?? 0) + line.quantity);
    if (typeof line.recentQuantity === "number") {
      recentDemand.set(
        demandKey,
        (recentDemand.get(demandKey) ?? 0) + line.recentQuantity,
      );
    }
  }

  const inventory = new Map(
    input.inventory.map((record) => [key(record.sku, record.warehouseId), record]),
  );
  const skus = [...new Set(input.inventory.map((item) => item.sku.toUpperCase()))];
  const recommendations: Recommendation[] = [];

  for (const sku of skus) {
    const records = input.warehouses.map((warehouse) => ({
      warehouse,
      inventory: inventory.get(key(sku, warehouse.id)),
      demand: demand.get(key(sku, warehouse.id)) ?? 0,
    }));
    const totalDemand = records.reduce((sum, row) => sum + row.demand, 0);
    const recentDemand14Days = hasRecencyData
      ? records.reduce(
          (sum, row) => sum + (recentDemand.get(key(sku, row.warehouse.id)) ?? 0),
          0,
        )
      : null;
    const totalAvailable = records.reduce(
      (sum, row) => sum + (row.inventory?.available ?? 0),
      0,
    );
    if (!totalDemand || !totalAvailable) continue;

    const targets = records.map((row) => ({
      ...row,
      target: Math.round(totalAvailable * (row.demand / totalDemand)),
    }));

    const sources = targets
      .filter((row) => (row.inventory?.available ?? 0) > row.target)
      .sort(
        (a, b) =>
          (b.inventory?.available ?? 0) - b.target -
          ((a.inventory?.available ?? 0) - a.target),
      );
    const destinations = targets
      .filter((row) => (row.inventory?.available ?? 0) < row.target)
      .sort(
        (a, b) =>
          b.target - (b.inventory?.available ?? 0) -
          (a.target - (a.inventory?.available ?? 0)),
      );

    for (const destination of destinations) {
      let deficit = destination.target - (destination.inventory?.available ?? 0);
      for (const source of sources) {
        const excess = (source.inventory?.available ?? 0) - source.target;
        const quantity = Math.min(excess, deficit);
        if (quantity < MIN_TRANSFER) continue;

        const projectedFrom = (source.inventory?.available ?? 0) - quantity;
        const projectedTo = (destination.inventory?.available ?? 0) + quantity;
        const sourceKitSources = kitSources.get(key(sku, source.warehouse.id));
        const destinationKitSources = kitSources.get(
          key(sku, destination.warehouse.id),
        );
        const affectedKits = [
          ...(sourceKitSources ?? []),
          ...(destinationKitSources ?? []),
        ].filter((value, index, values) => values.indexOf(value) === index);
        const destinationShare = Math.round(
          (destination.demand / totalDemand) * 100,
        );
        const confidence: Recommendation["confidence"] =
          totalDemand >= 100 ? "High" : totalDemand >= 30 ? "Medium" : "Low";
        const historicalDailyRate = totalDemand / input.lookbackDays;
        const recentDailyRate = (recentDemand14Days ?? 0) / 14;
        const recencyStatus: Recommendation["recencyStatus"] =
          recentDemand14Days === null
            ? "unknown"
            : recentDemand14Days === 0
              ? "inactive"
              : recentDailyRate < historicalDailyRate * 0.5
                ? "slowing"
                : "active";
        const adjustedConfidence: Recommendation["confidence"] =
          recencyStatus === "inactive"
            ? "Low"
            : recencyStatus === "slowing" && confidence === "High"
              ? "Medium"
              : confidence;
        const recencyReason =
          recencyStatus === "inactive"
            ? "No included shipments in the last 14 days. Confirm the SKU is still used before moving it."
            : recencyStatus === "slowing"
              ? `Only ${recentDemand14Days} units shipped in the last 14 days; its recent daily rate is less than half of the selected-window rate.`
              : recencyStatus === "active"
                ? `${recentDemand14Days} units shipped in the last 14 days, confirming current demand.`
                : "A 14-day demand comparison is unavailable for this data source.";

        recommendations.push({
          id: `${sku}-${source.warehouse.id}-${destination.warehouse.id}`,
          sku,
          productName:
            source.inventory?.productName ??
            destination.inventory?.productName ??
            sku,
          fromWarehouse: source.warehouse,
          toWarehouse: destination.warehouse,
          quantity,
          fromAvailable: source.inventory?.available ?? 0,
          toAvailable: destination.inventory?.available ?? 0,
          fromDemand: source.demand,
          toDemand: destination.demand,
          projectedFromDays: daysOfCover(
            projectedFrom,
            source.demand,
            input.lookbackDays,
          ),
          projectedToDays: daysOfCover(
            projectedTo,
            destination.demand,
            input.lookbackDays,
          ),
          confidence: adjustedConfidence,
          reason: `${destinationShare}% of recent demand shipped from ${destination.warehouse.code}, but only ${Math.round(((destination.inventory?.available ?? 0) / totalAvailable) * 100)}% of available stock is there.`,
          kitSources: affectedKits,
          recentDemand14Days,
          recencyStatus,
          recencyReason,
        });
        deficit -= quantity;
        source.target += quantity;
        if (deficit <= 0) break;
      }
    }
  }

  recommendations.sort((a, b) => b.quantity - a.quantity);
  const shippedUnits = input.shipments.reduce((sum, row) => sum + row.quantity, 0);
  const componentUnits = expanded.reduce((sum, row) => sum + row.quantity, 0);
  const recentUnits14Days = hasRecencyData
    ? expanded.reduce((sum, row) => sum + (row.recentQuantity ?? 0), 0)
    : null;
  const recommendedUnits = recommendations.reduce(
    (sum, row) => sum + row.quantity,
    0,
  );

  return {
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    lookbackDays: input.lookbackDays,
    client: input.client,
    warehouses: input.warehouses,
    metrics: {
      shippedUnits,
      componentUnits,
      activeSkus: skus.length,
      recentUnits14Days,
      recommendedUnits,
      estimatedCoverageGainDays: recommendations.length
        ? Math.round(
            recommendations.reduce(
              (sum, item) => sum + (item.projectedToDays ?? 0),
              0,
            ) / recommendations.length,
          )
        : 0,
    },
    recommendations,
    dataSource: input.dataSource ?? "shiphero-api",
    dataAsOf: input.dataAsOf,
    exclusions: input.exclusions ?? [],
  };
}
