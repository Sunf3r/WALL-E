import { DB } from 'https://deno.land/x/sqlite@v3.9.1/mod.ts'

const db = new DB('conf/sqlite.db')

// Create table users
db.execute(`CREATE TABLE IF NOT EXISTS users (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT,
    phone   TEXT UNIQUE NOT NULL,
    lang    TEXT,
    prefix  TEXT,
    cmds    INTEGER DEFAULT 0
    );`)

export default db
