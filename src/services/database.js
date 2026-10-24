let PoolClass;
let pool;
let tableReady;

export function isDatabaseConfigured() {
    return Boolean(process.env.DATABASE_URL?.trim());
}

async function getPool() {
    if (!isDatabaseConfigured()) throw new Error("DATABASE_URL não está configurada.");

    if (!PoolClass) {
        const module = await import("pg");
        PoolClass = module.default?.Pool ? module.default : module;
    }

    if (!pool) {
        pool = new PoolClass({
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
        tableReady = getPool().then(db => db.query(
            "CREATE TABLE IF NOT EXISTS bot_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )).catch(error => {
            tableReady = null;
            throw error;
        });
    }
    await tableReady;
}

export async function getStoredValue(key) {
    await ensureTable();
    const db = await getPool();
    const result = await db.query("SELECT value FROM bot_kv WHERE key = $1", [key]);
    return result.rows[0]?.value;
}

export async function setStoredValue(key, value) {
    await ensureTable();
    const db = await getPool();
    await db.query(
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
