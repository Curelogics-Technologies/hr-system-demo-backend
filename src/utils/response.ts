import { Response } from 'express';

export function ok<T>(res: Response, data: T, message?: string): void {
  res.json({ success: true, data, ...(message ? { message } : {}) });
}

export function created<T>(res: Response, data: T, message?: string): void {
  res.status(201).json({ success: true, data, ...(message ? { message } : {}) });
}

export function noContent(res: Response): void {
  res.status(204).send();
}

export function badRequest(res: Response, error: string, code = 'BAD_REQUEST', extra?: Record<string, any>): void {
  res.status(400).json({ success: false, error, code, ...extra });
}


export function unauthorized(res: Response, error = 'Non autenticato', code = 'UNAUTHORIZED'): void {
  res.status(401).json({ success: false, error, code });
}

export function forbidden(res: Response, error = 'Accesso negato', code = 'FORBIDDEN'): void {
  res.status(403).json({ success: false, error, code });
}

export function notFound(res: Response, error = 'Risorsa non trovata', code = 'NOT_FOUND'): void {
  res.status(404).json({ success: false, error, code });
}

export function conflict(
  res: Response,
  error: string,
  code = 'CONFLICT',
  // Extra context the client needs to offer a sensible override — e.g. which
  // approved leave a shift would land on.
  details?: Record<string, unknown>,
): void {
  res.status(409).json({ success: false, error, code, ...(details ? { details } : {}) });
}

export function serverError(res: Response, error = 'Errore interno del server', code = 'SERVER_ERROR'): void {
  res.status(500).json({ success: false, error, code });
}
