import pg from "pg";

const { Pool } = pg;
let pool;
let tableReady;

export function isDatabaseConfigured() {
    return Boolean(process.env.DATABASE_URL?.trim());
}

function getPool() {
    if (!isDatabaseConfigured()) throw new Error("DATABASE_URL não está configurada.");

    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
            max: 2,
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 5000
        });
        pool.on("error", error => console.error("⚠️ Erro no pool do banco:", error?.message || error));
    }
    return pool;
}

async function ensureTable() {
    if (!tableReady) {
        tableReady = getPool().query(
            "CREATE TABLE IF NOT EXISTS bot_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        ).catch(error => {
            tableReady = null;
            throw error;
        });
    }
    await tableReady;
}

export async function getStoredValue(key) {
    await ensureTable();
    const result = await getPool().query("SELECT value FROM bot_kv WHERE key = $1", [key]);
    return result.rows[0]?.value;
}

export async function setStoredValue(key, value) {
    await ensureTable();
    await getPool().query(
        "INSERT INTO bot_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        [key, JSON.stringify(value)]
    );
}

export async function closeDatabase() {
    if (!pool) return;
    await pool.end();
    pool = null;
    tableReady = null;
}
