import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL, pn TEXT, lid TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  in_group INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  name TEXT, location TEXT, company TEXT, company_norm TEXT, role TEXT,
  exp TEXT, exp_min INTEGER, exp_max INTEGER,
  techs TEXT, tech_other TEXT, projects TEXT,
  open_to_work TEXT, notice INTEGER, linkedin TEXT, reach TEXT,
  answers TEXT, session TEXT,
  created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS users_jid ON users(jid);
CREATE INDEX IF NOT EXISTS users_pn ON users(pn);
CREATE INDEX IF NOT EXISTS users_lid ON users(lid);
CREATE TABLE IF NOT EXISTS join_requests (
  jid TEXT PRIMARY KEY, pn TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poster INTEGER NOT NULL, company TEXT NOT NULL, role TEXT NOT NULL, type TEXT NOT NULL,
  techs TEXT NOT NULL, tech_other TEXT, exp_min INTEGER NOT NULL, exp_max INTEGER NOT NULL,
  location TEXT NOT NULL, max_notice INTEGER NOT NULL, details TEXT,
  status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, requester INTEGER NOT NULL,
  company TEXT, tech TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, ref_id INTEGER NOT NULL,
  from_user INTEGER NOT NULL, to_user INTEGER NOT NULL,
  status TEXT NOT NULL, self INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS asks_to ON asks(to_user, status);
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ask_id INTEGER NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL, media TEXT, created_at INTEGER NOT NULL, posted_at INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter INTEGER NOT NULL, target INTEGER NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);
`

export class Db {
  raw: DatabaseSync
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.raw = new DatabaseSync(file)
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL')
    this.raw.exec(SCHEMA)
  }
  get<T = any>(sql: string, ...p: any[]): T | undefined {
    return this.raw.prepare(sql).get(...p) as T | undefined
  }
  all<T = any>(sql: string, ...p: any[]): T[] {
    return this.raw.prepare(sql).all(...p) as T[]
  }
  run(sql: string, ...p: any[]) {
    return this.raw.prepare(sql).run(...p)
  }
  insert(sql: string, ...p: any[]): number {
    return Number(this.raw.prepare(sql).run(...p).lastInsertRowid)
  }
}
