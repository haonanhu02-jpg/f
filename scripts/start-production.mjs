import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
process.env.PORT ||= '8080';
process.env.ARCHIVE_DB_PATH ||= fileURLToPath(new URL('backend/data/archive.sqlite',root));
process.env.ARCHIVE_STATIC_DIR ||= fileURLToPath(new URL('frontend/dist-production',root));
process.env.ARCHIVE_ALLOWED_ORIGINS ||= `http://127.0.0.1:${process.env.PORT},http://localhost:${process.env.PORT}`;
// Start the same standalone entry used by Linux systemd, in this process.
process.argv[1]=fileURLToPath(new URL('backend/src/server.mjs',root));
await import(new URL('backend/src/server.mjs',root));
