import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { sendStickerPack } from "../../services/stickerPack.js";
import { enqueuePack } from "../../services/packQueue.js";
import { searchMasterGooglePhotos } from "../../services/googlePhotosMaster.js";
import { searchPinterest } from "../../services/pinterestScraper.js";
import webp from "node-webpmux";
import { runFFmpegSticker } from "../../services/ffmpeg.js";
import { tryTurboJpegSticker } from "../../services/turbojpeg.js";
import { trySharpSticker } from "../../services/sharpSticker.js";
import { rememberMegapack } from "../../services/megapackHistory.js";

const TOTAL = 60;
// Um único conversor por pack reduz o pico de RAM em aparelhos Android limitados.
const CONCURRENCY = 1;
const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_STICKER = 1024 * 1024;
const MAX_CANDIDATES = 120;
const MAX_SEARCH_PAGES = 5;
const MIN_DELAY = 100;
const MAX_DELAY = 200;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const shuffle = input => {
    const result = [...input];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
};
const isAnimated = url => /\.gif(?:[?#]|$)/i.test(String(url || ""));

async function googlePhotos(query) {
    try { return await searchMasterGooglePhotos(query); }
    catch (e) { console.log("⚠️ Google Fotos:", e.message); return []; }
}

async function findImages(query) {
    const all = [];
    const seen = new Set();

    const add = list => {
        for (const x of list || []) {
            if (all.length >= MAX_CANDIDATES) break;
            if (!x?.url || seen.has(x.url)) continue;
            seen.add(x.url);
            all.push({ ...x, animated: x.animated || isAnimated(x.url) });
        }
    };

    add(await googlePhotos(query));
    if (all.length < TOTAL * 2) {
        const pins = await searchPinterest(query, Math.min(MAX_CANDIDATES, Math.max(TOTAL * 2, 80)));
        add(pins.map(pin => ({ ...pin, source: "pinterest" })));
    }

    const selected = [
        ...shuffle(all.filter(x => x.animated)).slice(0, 30),
        ...shuffle(all.filter(x => !x.animated)).slice(0, 30)
    ];

    for (const x of shuffle(all)) {
        if (selected.length >= TOTAL) break;
        if (!selected.some(y => y.url === x.url)) selected.push(x);
    }

    return shuffle(selected).slice(0, TOTAL);
}

async function download(url, file) {
    if (!url || typeof url !== "string") throw new Error("imagem sem URL válida");

    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36",
            Referer: "https://www.pinterest.com/"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    if (!res.body) throw new Error("resposta sem conteúdo de imagem");

    const { Readable } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    const { createWriteStream } = await import("node:fs");
    let total = 0;
    const source = Readable.fromWeb(res.body);
    source.on("data", chunk => {
        total += chunk.length;
        if (total > MAX_IMAGE) source.destroy(new Error("imagem muito grande"));
    });

    try {
        await pipeline(source, createWriteStream(file, { flags: "wx" }));
        if (total === 0) throw new Error("imagem vazia");
    } catch (error) {
        await fs.unlink(file).catch(() => {});
        throw error;
    }
}

async function convert(input, output, animated) {
    // Primeiro tenta Sharp para imagens estáticas. Ele é opcional: se não
    // estiver instalado/compatível ou falhar, segue para TurboJPEG e FFmpeg.
    if (!animated) {
        for (const quality of [80, 55]) {
            if (await trySharpSticker(input, output, quality)) {
                if ((await fs.stat(output)).size <= MAX_STICKER) return;
                await fs.unlink(output).catch(() => {});
            }
        }

        // JPEG estático: TurboJPEG + cwebp continua como segunda alternativa.
        for (const quality of [80, 55]) {
            if (await tryTurboJpegSticker(input, output, quality)) {
                if ((await fs.stat(output)).size <= MAX_STICKER) return;
                await fs.unlink(output).catch(() => {});
            }
        }
    }

    // FFmpeg permanece como fallback final e como caminho para mídia animada.
    const encode = async (quality, fps) => {
        await runFFmpegSticker(input, output, animated ? "video" : "image", {
            quality,
            fps,
            duration: 15
        });
    };

    await encode(animated ? 70 : 80, animated ? 12 : 1);
    if ((await fs.stat(output)).size > MAX_STICKER) {
        await fs.unlink(output).catch(() => {});
        await encode(animated ? 45 : 55, animated ? 8 : 1);
        if ((await fs.stat(output)).size > MAX_STICKER) {
            throw new Error("sticker maior que 1 MB");
        }
    }
}

function createStickerExif(packname, author) {
    const json = Buffer.from(JSON.stringify({
        "sticker-pack-id": "chiru san bot",
        "sticker-pack-name": packname,
        "sticker-pack-publisher": author,
        emojis: ["🌸"]
    }), "utf-8");

    const exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00,
        0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00,
        0x00, 0x00
    ]);

    const exif = Buffer.concat([exifAttr, json]);
    exif.writeUIntLE(json.length, 14, 4);
    return exif;
}

async function addStickerMetadata(file, packname, author) {
    const img = new webp.Image();
    await img.load(file);
    img.exif = createStickerExif(packname, author);
    await img.save(file);
}

async function makeStickers(items, dir, packname, author) {
    const out = [];
    let index = 0;

    async function worker() {
        while (index < items.length && out.length < TOTAL) {
            const item = items[index++];
            const id = randomUUID();
            const input = path.join(dir, id + ".img");
            const output = path.join(dir, id + ".webp");

            try {
                await download(item.url, input);
                await convert(input, output, item.animated);
                await addStickerMetadata(output, packname, author);
                const buf = await fs.readFile(output);
                if (buf.length <= MAX_STICKER) {
                    out.push(buf);
                    console.log(`✅ ${out.length}/${TOTAL}`);
                }
            } catch (e) {
                console.log("⚠️ Imagem:", e.message);
            } finally {
                await fs.unlink(input).catch(() => {});
                await fs.unlink(output).catch(() => {});
            }
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return out.slice(0, TOTAL);
}

export default {
    name: "pack",
    aliases: ["stickerpack", "figpack"],
    description: "Gera pack de stickers",
    async execute(sock, msg, args) {
        const query = (args || []).join(" ").trim();
        const from = msg.key.remoteJid;

        if (!query) {
            return sock.sendMessage(
                from,
                { text: "Use: *.pack nome do personagem*" },
                { quoted: msg }
            );
        }

        const requester = String(
            msg.pushName || msg.verifiedBizName || "usuário"
        ).trim();

        // Registra o pedido antes de entrar na fila, para que o histórico sobreviva
        // mesmo se o bot reiniciar enquanto o pack estiver aguardando.
        await rememberMegapack({
            jid: msg.key.participant || from,
            chatJid: from,
            query,
            requester
        });

        let statusMessageKey = null;
        let lastStatusText = "";
        let statusChain = Promise.resolve();

        const updateSingleStatus = text => {
            statusChain = statusChain.then(async () => {
                if (lastStatusText === text) return;

                if (!statusMessageKey) {
                    const sent = await sock.sendMessage(from, { text }, { quoted: msg });
                    statusMessageKey = sent?.key || null;
                } else {
                    await sock.sendMessage(from, { text, edit: statusMessageKey });
                }

                lastStatusText = text;
            }).catch(error => {
                console.error(`⚠️ Não consegui atualizar a mensagem da fila para "${query}":`, error);
            });

            return statusChain;
        };

        const queueStatusText = status => {
            if (msg.packBatch) return msg.packBatch.updateStatus?.();
            if (status.state === "running") return updateSingleStatus(`⚙️ Gerando o pack de *${query}*...\n\nA fila está trabalhando nele agora!`);
            return updateSingleStatus(`⏳ Pack de *${query}* na fila\n📍 Posição: *${status.position}*`);
        };

        return enqueuePack(async ({ id }) => {
            let dir;
            let candidates = [];
            let stickers = [];
            let packSucceeded = false;

            try {
                dir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-"));

                 console.log(`📦 [pack ${id}] Iniciando "${query}" solicitado por ${requester}`);

                candidates = await findImages(query);
                if (!candidates.length) {
                    if (msg.packBatch) msg.packBatch.failed = true;
                    else {
                        await updateSingleStatus(`❌ Não encontrei imagens suficientes para *${query}*.`);
                        await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
                    }
                    return;
                }

                const author = `Chiru san bot • ${requester}`;
                stickers = await makeStickers(candidates, dir, query, author);
                candidates.length = 0;
                candidates = [];

                if (stickers.length < 5) {
                    if (msg.packBatch) msg.packBatch.failed = true;
                    else {
                        await updateSingleStatus(`❌ Não consegui gerar stickers suficientes para *${query}*.`);
                        await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
                    }
                    return;
                }

                const stickerCount = stickers.length;
                await sendStickerPack(sock, from, stickers, {
                    name: query,
                    publisher: author,
                    description: `🌸 ${query}`
                });

                packSucceeded = true;
                // Solta os buffers originais assim que o envio terminar.
                stickers.length = 0;
                stickers = [];
                if (!msg.packBatch) {
                    await updateSingleStatus(`✅ Pack de *${query}* concluído com ${stickerCount} figurinhas!`);
                    await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
                }

                console.log(`✅ [pack ${id}] Concluído "${query}" (${stickerCount} stickers)`);
            } catch (e) {
                console.error(`❌ [pack ${id}] Erro em "${query}":`, e);

                if (!msg.packBatch) {
                    await updateSingleStatus(`❌ Falha ao gerar o pack de *${query}*.`);
                    try {
                        await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
                    } catch (sendError) {
                        console.error(`❌ [pack ${id}] Também falhou ao reagir à mensagem:`, sendError);
                    }
                }

                throw e;
            } finally {
                // Libera referências a buffers de imagens antes do próximo pack.
                stickers.length = 0;
                stickers = [];
                candidates.length = 0;
                candidates = [];
                if (dir) {
                    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
                }

                // Se o Node foi iniciado com --expose-gc, recolhe os buffers
                // já sem referências antes de o próximo pack começar.
                if (typeof global.gc === "function") {
                    global.gc();
                }
                // Cede o event loop para concluir callbacks de I/O/liberação.
                await sleep(50);

                const mem = process.memoryUsage();
                console.log(`🧠 [pack ${id}] Memória após limpeza: RSS=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB external=${Math.round(mem.external / 1048576)}MB arrayBuffers=${Math.round(mem.arrayBuffers / 1048576)}MB`);

                if (msg.packBatch) {
                    if (!packSucceeded) msg.packBatch.failed = true;
                    msg.packBatch.remaining -= 1;

                    if (msg.packBatch.remaining === 0 && !msg.packBatch.finalized) {
                        msg.packBatch.finalized = true;
                        const emoji = msg.packBatch.failed ? "❌" : "✅";
                        try {
                            await msg.packBatch.updateStatus?.();
                            await sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
                        } catch (reactionError) {
                            console.error("⚠️ Não consegui finalizar o status do megapack:", reactionError);
                        }
                    } else {
                        await msg.packBatch.updateStatus?.();
                    }
                }
            }
        }, {
            awaitCompletion: Boolean(msg.packBatch?.sequential),
            onQueued: async ({ position }) => {
                if (msg.packBatch) return;
                await updateSingleStatus(`⏳ Pack de *${query}* na fila\n📍 Posição: *${position}*`);
                await sock.sendMessage(from, {
                    react: { text: "⏳", key: msg.key }
                });
            },
            onQueueUpdate: status => queueStatusText(status)
        });
    }
};