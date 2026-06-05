/**
 * Cloud smoke test: drives the *deployed* MCP server over streamable HTTP,
 * exactly as a remote MCP client would, and runs the Step-2 buyer task against
 * the deployed mock StoreLink.
 *
 *   MCP_URL=https://<mcp-domain>/mcp npm run cloud-smoke
 *   (or pass the URL as the first arg)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? process.argv[2];
if (!url) {
  console.error("Usage: MCP_URL=https://<domain>/mcp npm run cloud-smoke");
  process.exit(2);
}

const SKU = "8847291";
const THRESHOLD = 6;

function textOf(res: any): string {
  return (res.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
}
function jsonOf(res: any): any {
  const t = textOf(res);
  return t.includes("```json") ? JSON.parse(t.split("```json")[1].split("```")[0]) : null;
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "cloud-smoke", version: "1.0.0" });
  await client.connect(transport);
  console.log(`connected → ${url}\n`);

  const tools = await client.listTools();
  console.log("Tools:", tools.tools.map((t) => t.name).join(", "), "\n");

  for (const store of ["47", "102"]) {
    const check = await client.callTool({
      name: "check_stock_position",
      arguments: { store_id: store, sku: SKU, window_hours: 24, threshold_units: THRESHOLD },
    });
    const d = jsonOf(check);
    console.log(`store ${store}: on_hand=${d.on_hand} sold24h=${d.units_sold} gap=${d.gap} -> ${d.recommendation}`);
    if (d.recommendation === "raise_replenishment") {
      const order = await client.callTool({
        name: "raise_replenishment",
        arguments: {
          store_id: store,
          sku: SKU,
          quantity: d.suggested_quantity,
          reason: `24h sales ${d.units_sold} vs on-hand ${d.on_hand}; gap ${d.gap} > ${THRESHOLD}.`,
        },
      });
      console.log("   " + textOf(order).split("\n")[0]);
    } else {
      console.log("   (within threshold — no order)");
    }
  }

  // Step-4 (b): a store we hold no key for must fail safely.
  const noCred = await client.callTool({ name: "check_stock_position", arguments: { store_id: "999", sku: SKU } });
  console.log(`\nstore 999 (no key): ${textOf(noCred).split("\n")[0]} ${noCred.isError ? "[isError ✓]" : "[✗]"}`);

  await client.close();
  console.log("\n✓ Cloud smoke complete.");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
