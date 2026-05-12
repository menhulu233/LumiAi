// src/main/domains/cowork/service/types/result.ts

export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E; canFallback?: boolean }

export function success<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function failure<E extends Error = Error>(
  error: E,
  options?: { canFallback?: boolean }
): Result<never, E> {
  return { ok: false, error, canFallback: options?.canFallback }
}
