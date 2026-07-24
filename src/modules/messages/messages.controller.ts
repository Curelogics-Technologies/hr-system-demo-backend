import { Request, Response } from 'express';
import { query, queryOne } from '../../config/database';
import { ok, created, forbidden, notFound, badRequest } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
import fs from 'fs';
import path from 'path';
import { emitToCompany } from '../../config/socket';

async function resolveMessageCompanyId(req: Request, res: Response): Promise<number | null> {
  if (!req.user) {
    forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
    return null;
  }

  const explicit =
    req.body?.company_id ??
    req.body?.companyId ??
    req.body?.target_company_id ??
    req.query?.company_id ??
    req.query?.companyId ??
    req.query?.target_company_id ??
    req.params?.company_id;

  const fallbackCompanyId = req.user.companyId;
  const targetCompanyId = explicit != null ? parseInt(String(explicit), 10) : fallbackCompanyId;

  if (targetCompanyId == null || Number.isNaN(targetCompanyId)) {
    forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
    return null;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user);
  if (!allowedCompanyIds.includes(targetCompanyId)) {
    forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
    return null;
  }

  return targetCompanyId;
}

// POST /api/messages — send a message to an employee
export const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const { userId, role } = req.user!;
  const { recipientId, recipient_id, subject, body, attachmentFilename, attachment_filename } = req.body as {
    recipientId?: number;
    recipient_id?: number;
    company_id?: number;
    target_company_id?: number;
    subject?: string;
    body?: string;
    attachmentFilename?: string | null;
    attachment_filename?: string | null;
  };

  const companyId = await resolveMessageCompanyId(req, res);
  if (companyId == null) {
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const rawRecipient = recipientId ?? recipient_id;
  const numRecipientId = typeof rawRecipient === 'number'
    ? rawRecipient
    : parseInt(String(rawRecipient), 10);
  if (!Number.isFinite(numRecipientId)) {
    badRequest(res, 'Destinatario non valido', 'INVALID_RECIPIENT');
    return;
  }

  const finalAttachmentFilename = attachmentFilename ?? attachment_filename ?? null;

  if (!body?.trim() && !finalAttachmentFilename) {
    badRequest(res, 'Il corpo del messaggio o un allegato è obbligatorio', 'MISSING_FIELDS');
    return;
  }

  const normalizedSubject = typeof subject === 'string' ? subject.trim() : '';

  // Try the requested company first, then any company the caller can access.
  let recipient = await queryOne<{ id: number; role: string; company_id: number }>(
    `SELECT id, role, company_id FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'`,
    [numRecipientId, companyId],
  );
  if (!recipient) {
    recipient = await queryOne<{ id: number; role: string; company_id: number }>(
      `SELECT id, role, company_id FROM users WHERE id = $1 AND company_id = ANY($2) AND status = 'active'`,
      [numRecipientId, allowedCompanyIds],
    );
  }
  // Conversation history fallback: if they already have an existing conversation, they can message each other.
  if (!recipient) {
    const hasHistory = await queryOne<{ id: number }>(
      `SELECT id FROM messages 
       WHERE (sender_id = $1 AND recipient_id = $2) 
          OR (sender_id = $2 AND recipient_id = $1) 
       LIMIT 1`,
      [userId, numRecipientId]
    );
    if (hasHistory) {
      recipient = await queryOne<{ id: number; role: string; company_id: number }>(
        `SELECT id, role, company_id FROM users WHERE id = $1 AND status = 'active'`,
        [numRecipientId]
      );
    }
  }
  // Centralized HR/admin fallback or group-wide active users fallback in same company group
  if (!recipient) {
    const senderGroupId = await queryOne<{ group_id: number | null }>(
      `SELECT group_id FROM companies WHERE id = $1`,
      [req.user!.companyId]
    );
    if (senderGroupId?.group_id != null) {
      if (role === 'hr' || role === 'admin') {
        // HR/admin can message ANY active user within the same company group
        recipient = await queryOne<{ id: number; role: string; company_id: number }>(
          `SELECT u.id, u.role, u.company_id 
           FROM users u
           JOIN companies c ON c.id = u.company_id
           WHERE u.id = $1 AND c.group_id = $2 AND u.status = 'active'`,
          [numRecipientId, senderGroupId.group_id],
        );
      } else {
        // Non-HR/admin can message HR/admin within the same company group
        recipient = await queryOne<{ id: number; role: string; company_id: number }>(
          `SELECT u.id, u.role, u.company_id 
           FROM users u
           JOIN companies c ON c.id = u.company_id
           WHERE u.id = $1 AND c.group_id = $2 AND u.status = 'active' AND (u.role = 'hr' OR u.role = 'admin')`,
          [numRecipientId, senderGroupId.group_id],
        );
      }
    }
  }
  if (!recipient) {
    notFound(res, 'Destinatario non trovato in questa azienda');
    return;
  }

  const messageCompanyId = recipient.company_id;

  // Employee can only chat with HR.
  if (role === 'employee') {
    if (recipient.role !== 'hr') {
      forbidden(res, "Puoi inviare messaggi solo all'HR");
      return;
    }
  }

  // Area manager: can message HR/admin for escalation, OR directly supervised employees
  if (role === 'area_manager') {
    const isHrOrAdmin = recipient.role === 'hr' || recipient.role === 'admin';
    if (!isHrOrAdmin) {
      const supervised = await queryOne<{ id: number }>(
        `SELECT id FROM users WHERE id = $1 AND supervisor_id = $2 AND company_id = $3`,
        [numRecipientId, userId, messageCompanyId],
      );
      if (!supervised) {
        forbidden(res, 'Puoi inviare messaggi solo ai dipendenti che supervisioni o all\'HR');
        return;
      }
    }
  }

  // Store manager: can message HR/admin for escalation, OR employees in their store
  if (role === 'store_manager') {
    const isHrOrAdmin = recipient.role === 'hr' || recipient.role === 'admin';
    if (!isHrOrAdmin) {
      const inStore = await queryOne<{ id: number }>(
        `SELECT id FROM users
         WHERE id = $1
           AND store_id = (SELECT store_id FROM users WHERE id = $2)
           AND company_id = $3`,
        [numRecipientId, userId, messageCompanyId],
      );
      if (!inStore) {
        forbidden(res, 'Puoi inviare messaggi solo ai dipendenti del tuo negozio o all\'HR');
        return;
      }
    }
  }

  const msg = await queryOne<any>(
    `INSERT INTO messages (company_id, sender_id, recipient_id, subject, body, attachment_filename)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, company_id, sender_id, recipient_id, subject, body, is_read, created_at, attachment_filename`,
    [messageCompanyId, userId, numRecipientId, normalizedSubject, body?.trim() || '', finalAttachmentFilename],
  );

  if (msg) {
    emitToCompany(messageCompanyId, 'MESSAGE_SENT', msg);
  }

  created(res, msg, 'Messaggio inviato');
});

// GET /api/messages/hr — returns the HR contact for current company
export const getHrRecipient = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveMessageCompanyId(req, res);
  if (companyId == null) {
    return;
  }

  const hr = await queryOne<{ id: number; name: string; surname: string | null }>(
    `SELECT id, name, surname
     FROM users
     WHERE company_id = $1 AND role = 'hr' AND status = 'active'
     ORDER BY name, surname
     LIMIT 1`,
    [companyId],
  );

  if (!hr) { notFound(res, "Contatto HR non trovato in questa azienda"); return; }

  const recipientName = hr.surname ? `${hr.name} ${hr.surname}` : hr.name;
  ok(res, { recipientId: hr.id, recipientName }, 'Contatto HR trovato');
});

// GET /api/messages — inbox + sent for current user
export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;

  const explicitCompany =
    req.body?.company_id ??
    req.body?.companyId ??
    req.body?.target_company_id ??
    req.query?.company_id ??
    req.query?.companyId ??
    req.query?.target_company_id ??
    req.params?.company_id;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) {
    ok(res, []);
    return;
  }

  const targetCompanyId = explicitCompany != null ? parseInt(String(explicitCompany), 10) : null;
  const companyIds = targetCompanyId != null ? [targetCompanyId] : allowedCompanyIds;

  if (targetCompanyId != null && !allowedCompanyIds.includes(targetCompanyId)) {
    forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
    return;
  }

  const messages = await query(
    `SELECT m.id, m.subject, m.body, m.attachment_filename,
            m.is_read,
            m.created_at,
            m.company_id,
            c.name AS company_name,
            m.sender_id, m.recipient_id,
            COALESCE(NULLIF(BTRIM(CONCAT(COALESCE(s.name, ''), ' ', COALESCE(s.surname, ''))), ''), CONCAT('User #', m.sender_id::TEXT)) AS sender_name,
            s.role AS sender_role,
                 s.avatar_filename AS sender_avatar_filename,
            COALESCE(NULLIF(BTRIM(CONCAT(COALESCE(r.name, ''), ' ', COALESCE(r.surname, ''))), ''), CONCAT('User #', m.recipient_id::TEXT)) AS recipient_name,
            r.role AS recipient_role,
                 r.avatar_filename AS recipient_avatar_filename,
            CASE WHEN m.recipient_id = $1 THEN 'received' ELSE 'sent' END AS direction
     FROM messages m
     LEFT JOIN users s ON s.id = m.sender_id
     LEFT JOIN users r ON r.id = m.recipient_id
     LEFT JOIN companies c ON c.id = m.company_id
     WHERE (m.recipient_id = $1 OR m.sender_id = $1)
     ORDER BY m.created_at DESC
     LIMIT 100`,
    [userId],
  );

  ok(res, messages);
});

// GET /api/messages/unread-count
export const unreadCount = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;

  const explicitCompany =
    req.body?.company_id ??
    req.body?.companyId ??
    req.body?.target_company_id ??
    req.query?.company_id ??
    req.query?.companyId ??
    req.query?.target_company_id ??
    req.params?.company_id;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) {
    ok(res, { unreadCount: 0 });
    return;
  }

  const targetCompanyId = explicitCompany != null ? parseInt(String(explicitCompany), 10) : null;
  const companyIds = targetCompanyId != null ? [targetCompanyId] : allowedCompanyIds;

  if (targetCompanyId != null && !allowedCompanyIds.includes(targetCompanyId)) {
    forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
    return;
  }

  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM messages WHERE recipient_id = $1 AND is_read = FALSE`,
    [userId],
  );
  ok(res, { unreadCount: row?.count ?? 0 });
});

// PATCH /api/messages/:id/read
export const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;
  const explicitCompany =
    req.body?.company_id ??
    req.body?.companyId ??
    req.body?.target_company_id ??
    req.query?.company_id ??
    req.query?.companyId ??
    req.query?.target_company_id ??
    req.params?.company_id;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) {
    forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
    return;
  }

  const targetCompanyId = explicitCompany != null ? parseInt(String(explicitCompany), 10) : null;
  const companyIds = targetCompanyId != null ? [targetCompanyId] : allowedCompanyIds;

  if (targetCompanyId != null && !allowedCompanyIds.includes(targetCompanyId)) {
    forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
    return;
  }

  const msgId = parseInt(req.params.id, 10);
  if (isNaN(msgId)) { notFound(res, 'Messaggio non trovato'); return; }

  const msg = await queryOne<{ id: number; recipient_id: number }>(
    `SELECT id, recipient_id FROM messages WHERE id = $1`,
    [msgId],
  );
  if (!msg) { notFound(res, 'Messaggio non trovato'); return; }
  if (msg.recipient_id !== userId) {
    forbidden(res, 'Non puoi modificare questo messaggio');
    return;
  }

  const updated = await queryOne(
    `UPDATE messages SET is_read = TRUE WHERE id = $1
     RETURNING id, subject, body, is_read, created_at, sender_id, recipient_id`,
    [msgId],
  );
  
  ok(res, updated);
});

export const uploadAttachment = asyncHandler(async (req: Request, res: Response) => {
  const file = (req as any).file;
  if (!file) {
    badRequest(res, 'File non caricato');
    return;
  }
  ok(res, { filename: file.filename }, 'File caricato con successo');
});

// PATCH /api/messages/:id — edit a message
export const editMessage = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;
  const msgId = parseInt(req.params.id, 10);
  const { body, subject, attachmentFilename } = req.body as { body?: string; subject?: string; attachmentFilename?: string | null };

  if (isNaN(msgId)) {
    notFound(res, 'Messaggio non trovato');
    return;
  }

  const msg = await queryOne<{ id: number; sender_id: number }>(
    `SELECT id, sender_id FROM messages WHERE id = $1`,
    [msgId],
  );

  if (!msg) {
    notFound(res, 'Messaggio non trovato');
    return;
  }

  if (msg.sender_id !== userId) {
    forbidden(res, 'Non puoi modificare questo messaggio');
    return;
  }

  const newBody = body !== undefined ? body.trim() : null;
  const newSubject = subject !== undefined ? (subject.trim() || null) : null;
  const newAttachment = attachmentFilename !== undefined ? (attachmentFilename || null) : null;

  const updated = await queryOne<any>(
    `UPDATE messages 
     SET body = COALESCE($1, body),
         subject = $2,
         attachment_filename = $3
     WHERE id = $4 
     RETURNING id, company_id, subject, body, is_read, created_at, sender_id, recipient_id, attachment_filename`,
    [newBody, newSubject, newAttachment, msgId],
  );

  if (updated) {
    emitToCompany(updated.company_id, 'MESSAGE_EDITED', updated);
  }

  ok(res, updated, 'Messaggio modificato');
});

// DELETE /api/messages/:id — delete a message
export const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;
  const msgId = parseInt(req.params.id, 10);

  if (isNaN(msgId)) {
    notFound(res, 'Messaggio non trovato');
    return;
  }

  const msg = await queryOne<{ id: number; company_id: number; sender_id: number; attachment_filename: string | null }>(
    `SELECT id, company_id, sender_id, attachment_filename FROM messages WHERE id = $1`,
    [msgId],
  );

  if (!msg) {
    notFound(res, 'Messaggio non trovato');
    return;
  }

  if (msg.sender_id !== userId) {
    forbidden(res, 'Non puoi eliminare questo messaggio');
    return;
  }

  // Delete physical attachment if it exists
  if (msg.attachment_filename) {
    const uploadsDir = process.env.UPLOADS_DIR
      ? path.dirname(process.env.UPLOADS_DIR)
      : path.join(process.cwd(), 'uploads');
    const filePath = path.join(uploadsDir, 'message-attachments', msg.attachment_filename);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error('Failed to delete physical message attachment file:', err);
    }
  }

  await query(`DELETE FROM messages WHERE id = $1`, [msgId]);

  if (msg) {
    emitToCompany(msg.company_id, 'MESSAGE_DELETED', { id: msgId });
  }

  ok(res, { id: msgId }, 'Messaggio eliminato');
});
