import type { ApiErrorBody } from '@memories/shared';

export type GoogleRequestDiagnostic = { operation:string; httpStatus:number; googleCode?:number; googleStatus?:string; reason?:string; domain?:string; service?:string; consumerProject?:string; message:string };
export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterMs?: number,public diagnostic?:GoogleRequestDiagnostic) { super(message); }
}

export async function request<T>(path: string, options: RequestInit = {}, csrfToken?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
    });
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Could not reach the studio. Check that the local server is running, then try again.');
  }
  if (!response.ok) {
    let body: (ApiErrorBody & {error:ApiErrorBody['error'] & {diagnostic?:GoogleRequestDiagnostic}}) | undefined;
    try { body = await response.json() as typeof body; } catch { /* A proxy error may not contain JSON. */ }
    throw new ApiClientError(response.status, body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? 'The request could not be completed. Please try again.', body?.error?.retryAfterMs,body?.error?.diagnostic);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
