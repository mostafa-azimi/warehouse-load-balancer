import { describe, expect, it } from "vitest";
import { buildAnalysis, expandKits } from "./balancing";
import { getDemoInput } from "./demo-data";

describe("inventory balancing", () => {
  it("expands kits into the physical component quantities", () => {
    const result = expandKits(
      [{ sku: "KIT", quantity: 3, warehouseId: "ATL" }],
      [{ sku: "KIT", components: [{ sku: "BOTTLE", quantity: 2 }] }],
    );
    expect(result.expanded).toEqual([
      { sku: "BOTTLE", quantity: 6, warehouseId: "ATL" },
    ]);
  });

  it("moves inventory toward the warehouse demand share", () => {
    const result = buildAnalysis(getDemoInput("demo-acct-1042", 90));
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.some((item) => item.kitSources.length > 0)).toBe(true);
    expect(result.metrics.recommendedUnits).toBeGreaterThan(0);
    expect(result.metrics.recentUnits14Days).toBeGreaterThan(0);
    expect(result.recommendations.every((item) => item.recencyStatus === "active")).toBe(true);
  });

  it("flags a recommendation when its SKU has no demand in the last 14 days", () => {
    const input = getDemoInput("demo-acct-1042", 90);
    input.shipments = input.shipments.map((line) => ({ ...line, recentQuantity: 0 }));
    const result = buildAnalysis(input);

    expect(result.recommendations[0].recencyStatus).toBe("inactive");
    expect(result.recommendations[0].confidence).toBe("Low");
    expect(result.recommendations[0].recencyReason).toContain("last 14 days");
  });
});
