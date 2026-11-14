import type { GoogleDiagnostic } from './google-diagnostics.js';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterMs?: number, public diagnostic?:GoogleDiagnostic) {
    super(message);
    this.name = 'ApiError';
  }
}
