import { useCallback, useEffect, useRef, useState } from "react";
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

type ApiMutationFn<TArgs, TResult> = (args: TArgs, signal: AbortSignal) => Promise<TResult>;

function toMutationError(err: unknown): MutationError {
  if (err instanceof ApiError) {
    return {
      code: err.code,
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
  fn: ApiMutationFn<TArgs, TResult>,
  opts?: UseApiMutationOptions<TArgs, TResult>,
): UseApiMutationResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MutationError | null>(null);
  const [data, setData] = useState<TResult | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const requestSeqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      requestSeqRef.current += 1;
    };
  }, []);

  const run = useCallback(async (args: TArgs): Promise<TResult | undefined> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current(args, controller.signal);
      if (requestSeqRef.current !== requestSeq || controller.signal.aborted) return undefined;
      setData(result);
      const handler = optsRef.current?.onSuccess;
      if (handler) await handler(result, args);
      return result;
    } catch (err) {
      if (requestSeqRef.current !== requestSeq || controller.signal.aborted) return undefined;
      const mutErr = toMutationError(err);
      setError(mutErr);
      optsRef.current?.onError?.(mutErr, args);
      return undefined;
    } finally {
      if (requestSeqRef.current === requestSeq) {
        if (controllerRef.current === controller) controllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestSeqRef.current += 1;
    setLoading(false);
    setError(null);
    setData(null);
  }, []);

  return { run, loading, error, data, reset };
}
