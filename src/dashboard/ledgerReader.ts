import type { StorageBackend } from "../storage/interface.js";

/** Paid clients have Portal credentials, not direct Supabase credentials. */
export async function readDashboardLedger(
  storage: Pick<StorageBackend, "getDashboardLedger" | "getLedgerEntries">,
  backend: string,
  project: string,
  order: "created_at.asc" | "created_at.desc",
  limit: number,
): Promise<unknown[]> {
  if (backend !== "synalux") {
    return storage.getLedgerEntries({ project: `eq.${project}`, order, limit: String(limit) });
  }
  if (!storage.getDashboardLedger) throw new Error("Cloud dashboard ledger reader unavailable");
  return storage.getDashboardLedger(project, order, limit);
}
