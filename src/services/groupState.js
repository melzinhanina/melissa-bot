import fs from "node:fs/promises";
import path from "node:path";
import { getStoredValue, setStoredValue, isDatabaseConfigured } from "./database.js";

const statePath = path.resolve("data/group-states.json");
let writeQueue = Promise.resolve();

async function readStates() {
    if (isDatabaseConfigured()) {
        try {
            const stored = await getStoredValue("groups.states");
            if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored;
        } catch (error) {
            console.warn("⚠️ Banco indisponível para estados dos grupos; usando arquivo local:", error?.message || error);
        }
    }

    try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        const states = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        if (isDatabaseConfigured()) {
            try { await setStoredValue("groups.states", states); } catch {}
        }
        return states;
    } catch (error) {
        if (error.code === "ENOENT") return {};
        console.error("❌ Não consegui ler os estados dos grupos:", error?.message || error);
        return {};
    }
}

async function saveStates(states) {
    if (isDatabaseConfigured()) {
        try {
            await setStoredValue("groups.states", states);
            return;
        } catch (error) {
            console.warn("⚠️ Não foi possível salvar estados dos grupos no banco; usando arquivo local:", error?.message || error);
        }
    }

    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(states, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, statePath);
}

export async function isGroupEnabled(groupJid) {
    if (typeof groupJid !== "string" || !groupJid.endsWith("@g.us")) return true;
    const states = await readStates();
    return states[groupJid] !== false;
}

export async function setGroupEnabled(groupJid, enabled) {
    if (typeof groupJid !== "string" || !groupJid.endsWith("@g.us")) {
        throw new Error("O estado só pode ser alterado dentro de um grupo.");
    }

    const operation = writeQueue.then(async () => {
        const states = await readStates();
        states[groupJid] = Boolean(enabled);
        await saveStates(states);
    });

    writeQueue = operation.catch(() => {});
    await operation;
}
