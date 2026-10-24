import fs from "node:fs/promises";
import { getStoredValue, setStoredValue, isDatabaseConfigured } from "./database.js";

const file =
    "./src/data/autosticker.json";


async function loadConfig() {
    if (isDatabaseConfigured()) {
        try {
            const stored = await getStoredValue("autosticker.config");
            if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored;
        } catch (error) {
            console.warn("⚠️ Banco indisponível para auto-sticker; usando arquivo local:", error?.message || error);
        }
    }

    try {
        const data = await fs.readFile(file, "utf8");
        const config = JSON.parse(data);
        if (isDatabaseConfigured()) {
            try { await setStoredValue("autosticker.config", config); } catch {}
        }
        return config;
    } catch {
        return {};
    }
}


async function saveConfig(config) {
    if (isDatabaseConfigured()) {
        try {
            await setStoredValue("autosticker.config", config);
            return;
        } catch (error) {
            console.warn("⚠️ Não foi possível salvar auto-sticker no banco; usando arquivo local:", error?.message || error);
        }
    }

    await fs.mkdir("./src/data", { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(config, null, 4), { mode: 0o600 });
}


export async function isEnabled(groupId) {

    const config =
        await loadConfig();

    return config[groupId] === true;

}


export async function enable(groupId) {

    const config =
        await loadConfig();

    config[groupId] = true;

    await saveConfig(
        config
    );

}


export async function disable(groupId) {

    const config =
        await loadConfig();

    config[groupId] = false;

    await saveConfig(
        config
    );

}
