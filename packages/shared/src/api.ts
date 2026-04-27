export interface ApiError {
  error: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ListEnvelope<T> {
  items: T[];
  nextCursor?: string;
}

export interface OkEnvelope {
  ok: true;
}
