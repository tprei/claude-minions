import { get as idbGet, set as idbSet } from "idb-keyval";
import type { Session, DAG } from "../types.js";

export interface ConnectionSnapshot {
  sessions: Session[];
  dags: DAG[];
}

export async function loadSnapshot(connId: string): Promise<ConnectionSnapshot | null> {
  const stored = await idbGet<ConnectionSnapshot>(`snap:${connId}`);
  return stored ?? null;
}

export async function saveSnapshot(connId: string, snapshot: ConnectionSnapshot): Promise<void> {
  await idbSet(`snap:${connId}`, snapshot);
}
