export type CheckpointReason = "turn" | "completion" | "manual" | "ship-stage";

export interface Checkpoint {
  id: string;
  sessionSlug: string;
  reason: CheckpointReason;
  sha: string;
  branch: string;
  message: string;
  turn: number;
  createdAt: string;
}
