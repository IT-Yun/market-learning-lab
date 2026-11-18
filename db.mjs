import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      title TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      revision INTEGER NOT NULL DEFAULT 1,
      request_id TEXT NOT NULL, UNIQUE(owner, request_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
      action TEXT NOT NULL, actor TEXT NOT NULL
    );`);
  return db;
}
