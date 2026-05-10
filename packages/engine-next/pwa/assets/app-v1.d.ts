export declare const state: {
  workflows: unknown[];
  currentId: string | null;
  currentWorkflow: { id: string; [key: string]: unknown } | null;
  transcript: unknown[];
  pushStatusByWorkflow: Record<string, string>;
  error: string | null;
  streamStatus: "connected" | "reconnecting" | "closed";
};
export declare function parseHash(hash: string): string | null;
export declare function transcriptNode(payload: unknown): HTMLElement;
export declare function renderReply(container: HTMLElement | null, workflow?: unknown): void;
export declare function loadWorkflowAndSubscribe(id: string): void;
export declare function formatTime(date: Date | string | number): string;
export declare function glyphFor(kind: string): string;
export declare function statusColorClass(status: string): string;
