import type Database from "better-sqlite3";
import type { RuntimeOverrides } from "@minions/shared";
import { nowIso } from "../../util/time.js";

interface RuntimeRow {
  id: number;
  values_json: string;
  updated_at: string;
}

export class RuntimeRepo {
  private readonly selectOne: Database.Statement;
  private readonly upsert: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectOne = db.prepare(`SELECT * FROM runtime_config WHERE id = 1`);
    this.upsert = db.prepare(
      `UPDATE runtime_config SET values_json = ?, updated_at = ? WHERE id = 1`
    );
  }

  read(): RuntimeOverrides {
    const row = this.selectOne.get() as RuntimeRow | undefined;
    if (!row) return {};
    return JSON.parse(row.values_json) as RuntimeOverrides;
  }

  write(values: RuntimeOverrides): void {
    this.upsert.run(JSON.stringify(values), nowIso());
  }
}
