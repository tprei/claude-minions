export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ListEnvelope<T> {
  items: T[];
  nextCursor?: string;
}

export interface OkEnvelope {
  ok: true;
}
