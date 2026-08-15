import { afterEach, describe, expect, it, vi } from "vitest";
import { listLiveClients } from "./shiphero";

describe("ShipHero customer allowlist", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALLOWED_CUSTOMER_ACCOUNT_IDS;
    delete process.env.SHIPHERO_ACCESS_TOKEN;
    delete process.env.SHIPHERO_REFRESH_TOKEN;
  });

  it("accepts numeric account numbers and configured display names", async () => {
    process.env.SHIPHERO_ACCESS_TOKEN = [
      "e30",
      Buffer.from(
        JSON.stringify({
          iat: Math.floor(Date.now() / 1_000),
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        }),
      ).toString("base64url"),
      "signature",
    ].join(".");
    process.env.SHIPHERO_REFRESH_TOKEN = "test-refresh-token";
    process.env.ALLOWED_CUSTOMER_ACCOUNT_IDS =
      "10001=Example Client,10002=Another Client";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            account: {
              data: {
                customers: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: [
                    {
                      node: {
                        id: "opaque-10001",
                        legacy_id: 987654,
                        username: "10001",
                        email: "client@example.com",
                        warehouse_relationship: { from_name: "API Name" },
                      },
                    },
                    {
                      node: {
                        id: "opaque-denied",
                        legacy_id: 11111,
                        username: "denied",
                        email: "denied@example.com",
                        warehouse_relationship: null,
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      }),
    );

    await expect(listLiveClients()).resolves.toEqual([
      {
        id: "opaque-10001",
        accountNumber: "10001",
        name: "Example Client",
      },
    ]);
  });
});
