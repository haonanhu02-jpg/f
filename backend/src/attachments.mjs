import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { ApiError, reject } from './schema.mjs';
import { requireWrite,requireCapability } from './access.mjs';

export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
export function initializeAttachments(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS attachments(
    id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES archives(id), name TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(archive_id,sha256));
    CREATE INDEX IF NOT EXISTS attachments_archive ON attachments(archive_id);`);
}
function metadata(row) {
  return { id: row.id, archiveId: row.archive_id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at };
}
export function listAttachments(store, archiveId) {
  store.get(archiveId);
  return store.db.prepare('SELECT id,archive_id,name,mime,size,sha256,created_at FROM attachments WHERE archive_id=? ORDER BY created_at,id').all(archiveId).map(metadata);
}
function detectFile(name, bytes) {
  if (!name || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name) || ['.', '..'].includes(name)) reject('附件名称无效，请使用不含路径的文件名。');
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_SIZE) reject('附件不能为空，单个文件最大20MB。');
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf' && bytes.subarray(0,5).toString() === '%PDF-') return 'application/pdf';
  if (ext === '.png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (['.jpg','.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (ext === '.webp' && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  reject('仅支持内容与扩展名一致的PDF、PNG、JPG/JPEG、WebP文件。', 'UNSUPPORTED_ATTACHMENT');
}
export function addAttachment(store, archiveId, name, content) {
  requireWrite();
  const bytes = Buffer.from(content), mime = detectFile(name, bytes);
  return store.transaction(() => {
    if (store.get(archiveId).status === 'void') reject('作废档案只读，不能新增附件。', 'ARCHIVE_VOID', 409);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const old = store.db.prepare('SELECT * FROM attachments WHERE archive_id=? AND sha256=?').get(archiveId,hash);
    if (old) return { ...metadata(old), duplicate: true };
    const id = randomUUID(), timestamp = new Date().toISOString();
    store.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)').run(id,archiveId,name,mime,bytes.length,hash,bytes,timestamp);
    store.event(archiveId,'attachment_added',{attachmentId:id,name,sha256:hash,size:bytes.length});
    return { id, archiveId, name, mime, size:bytes.length, sha256:hash, createdAt:timestamp, duplicate:false };
  });
}
export function attachmentContent(store, id) {
  requireCapability('canDownload');
  const row = store.db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
  if (!row) throw new ApiError(404,'NOT_FOUND','附件不存在。');
  store.get(row.archive_id);
  return { ...metadata(row), content: Buffer.from(row.content) };
}
export function disposition(name, inline = false) {
  return `${inline ? 'inline' : 'attachment'}; filename="archive-file"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
