import { create } from "zustand";
import type { DAG } from "../types.js";

interface DagStore {
  dags: Map<string, DAG>;
  replaceAll: (dags: DAG[]) => void;
  upsert: (dag: DAG) => void;
  remove: (id: string) => void;
}

export const useDagStore = create<DagStore>((set) => ({
  dags: new Map(),

  replaceAll(dags) {
    const map = new Map<string, DAG>();
    for (const d of dags) map.set(d.id, d);
    set({ dags: map });
  },

  upsert(dag) {
    set(s => {
      const dags = new Map(s.dags);
      dags.set(dag.id, dag);
      return { dags };
    });
  },

  remove(id) {
    set(s => {
      const dags = new Map(s.dags);
      dags.delete(id);
      return { dags };
    });
  },
}));
