/**
 * Which files the document module accepts.
 *
 * Payroll archives routinely carry companion data files next to the payslips -
 * the client's 26-payslip ZIP also contained `2643_CEDOLINO.xml`, a payroll
 * data export, which was imported as if it were a document. Unsupported entries
 * are now skipped and reported, instead of being stored or failing the whole
 * archive.
 */
import path from 'path';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.p7m': 'application/pkcs7-mime',
};

/** Extensions accepted as employee documents. */
export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

export function extensionOf(filename: string): string {
  return path.extname(filename || '').toLowerCase();
}

export function isSupportedDocumentFile(filename: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXTENSION, extensionOf(filename));
}

export function mimeTypeForFilename(filename: string): string {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? 'application/octet-stream';
}

/**
 * Archive entries that are packaging noise rather than user content:
 * macOS resource forks, thumbnail caches, hidden files, empty names.
 */
export function isArchiveNoise(entryName: string, baseName: string): boolean {
  if (!baseName) return true;
  if (baseName.startsWith('.')) return true;
  if (entryName.includes('__MACOSX')) return true;
  if (baseName.toLowerCase() === 'thumbs.db') return true;
  if (baseName.toLowerCase() === 'desktop.ini') return true;
  return false;
}
