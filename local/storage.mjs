import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export async function storage(root) {
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(join(root, 'shri-print.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const { readdir } = await import('node:fs/promises');
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url)))
    .filter(f => f.endsWith('.sql'))
    .sort())
    if (!db.prepare('SELECT name FROM _migrations WHERE name=?').get(file)) {
      db.exec('BEGIN');
      try {
        db.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
        db.prepare('INSERT INTO _migrations VALUES (?)').run(file);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  function statement(sql, args = []) {
    return {
      bind(...values) {
        return statement(sql, values);
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
      async first() {
        return db.prepare(sql).get(...args) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
    };
  }
  const dir = join(root, 'documents');
  await mkdir(dir, { recursive: true });
  const filename = key => join(dir, Buffer.from(key).toString('hex'));
  return {
    db,
    DB: { prepare: statement },
    BUCKET: {
      async put(key, bytes) {
        const file = filename(key);
        await writeFile(file + '.tmp', bytes);
        await rename(file + '.tmp', file);
      },
      async get(key) {
        try {
          return { body: await readFile(filename(key)) };
        } catch (e) {
          if (e.code === 'ENOENT') return null;
          throw e;
        }
      },
      async delete(key) {
        try {
          await unlink(filename(key));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      },
    },
  };
}
