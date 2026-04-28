import { useCallback, useRef, useState } from "react";
import { ApiError } from "../transport/rest.js";

export interface MutationError {
  code: string;
  message: string;
  status?: number;
  detail?: Record<string, unknown>;
}

export interface UseApiMutationResult<TArgs, TResult> {
  run: (args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: MutationError | null;
  data: TResult | null;
  reset: () => void;
}

export interface UseApiMutationOptions<TArgs, TResult> {
  onSuccess?: (result: TResult, args: TArgs) => void | Promise<void>;
  onError?: (err: MutationError, args: TArgs) => void;
}

function toMutationError(err: unknown): MutationError {
  if (err instanceof ApiError) {
    return {
      code: err.error,
      message: err.message,
      status: err.status,
      detail: err.detail,
    };
  }
  if (err instanceof Error) {
    return { code: "client_error", message: err.message };
  }
  return { code: "unknown", message: String(err) };
}

export function useApiMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  opts?: UseApiMutationOptions<TArgs, TResult>,
): UseApiMutationResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MutationError | null>(null);
  const [data, setData] = useState<TResult | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const run = useCallback(async (args: TArgs): Promise<TResult | undefined> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current(args);
      setData(result);
      const handler = optsRef.current?.onSuccess;
      if (handler) await handler(result, args);
      return result;
    } catch (err) {
      const mutErr = toMutationError(err);
      setError(mutErr);
      optsRef.current?.onError?.(mutErr, args);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setData(null);
  }, []);

  return { run, loading, error, data, reset };
}
