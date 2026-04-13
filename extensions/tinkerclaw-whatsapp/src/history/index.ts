/**
 * FORK: WhatsApp History — barrel export.
 *
 * Re-exports the public API surface of the history subsystem: SQLite database
 * operations, live message capture binding, and WhatsApp export import utilities.
 */

export {
  searchMessages,
  getStats,
  insertMessage,
  insertMessages,
  upsertChat,
  upsertContact,
  getContactName,
  getChatName,
  getDb,
  closeDb,
  type MessageRecord,
} from "./db.js";
export { bindWmHistoryCapture } from "./live-capture.js";
export { importExportFile, importDirectory, formatImportResults } from "./import-export.js";
