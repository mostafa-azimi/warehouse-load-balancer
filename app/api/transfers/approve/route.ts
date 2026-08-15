import { NextRequest, NextResponse } from "next/server";
import type { Recommendation } from "@/lib/types";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    clientId?: string;
    recommendations?: Recommendation[];
  };
  if (!body.clientId || !body.recommendations?.length) {
    return NextResponse.json({ error: "Select at least one recommendation." }, { status: 400 });
  }

  const batchId = `TR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const groups = body.recommendations.reduce<Map<string, Recommendation[]>>(
    (result, item) => {
      const route = `${item.fromWarehouse.id}::${item.toWarehouse.id}`;
      result.set(route, [...(result.get(route) ?? []), item]);
      return result;
    },
    new Map(),
  );
  const documents = [...groups.values()].map((items, index) => {
    const first = items[0];
    const suffix = String(index + 1).padStart(2, "0");
    return {
      route: `${first.fromWarehouse.code} → ${first.toWarehouse.code}`,
      salesOrder: `${batchId}-SO-${suffix}`,
      purchaseOrder: `${batchId}-PO-${suffix}`,
      lineItems: items.map((item) => ({ sku: item.sku, quantity: item.quantity })),
      status: "preview",
    };
  });

  return NextResponse.json({
    batchId,
    status: "approved-preview",
    message: "Approval recorded and paired sales order / purchase order drafts generated. Live ShipHero mutations are intentionally disabled for this MVP.",
    documents,
  });
}
