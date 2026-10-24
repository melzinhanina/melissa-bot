import { createServer } from "node:http";

let server;

export function startHealthServer() {
    if (server) return server;

    const port = Number.parseInt(process.env.PORT || "3000", 10);
    server = createServer((req, res) => {
        if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ status: "ok", service: "melissa-bot" }));
            return;
        }

        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "not_found" }));
    });

    server.on("error", error => {
        console.error("❌ Servidor HTTP de saúde:", error?.message || error);
    });

    server.listen(port, "0.0.0.0", () => {
        console.log("🩺 Health check disponível na porta " + port);
    });

    return server;
}
