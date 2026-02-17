/**
 * Polyblocks CLOB Proxy — Heroku EU (Ireland)
 *
 * Tiny reverse proxy that forwards all requests to Polymarket's CLOB API.
 * Runs in Heroku EU region (eu-west-1, Ireland) to bypass US geoblock.
 *
 * Your US Heroku app sets POLYMARKET_CLOB_HOST to this proxy's URL.
 * This proxy transparently forwards everything to clob.polymarket.com.
 */

import Fastify from "fastify";

const app = Fastify({ logger: true });

const CLOB_TARGET = process.env.CLOB_TARGET || "https://clob.polymarket.com";
const API_KEY = process.env.API_KEY || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

// ── Health check ──────────────────────────────────────────────────────────
app.get("/health", async () => ({ status: "ok", region: "eu", target: CLOB_TARGET }));

// ── Catch-all proxy ───────────────────────────────────────────────────────
app.all("/*", async (req, reply) => {
  // Optional API key check — only enforce on write requests (POST/PUT/DELETE)
  // GET/HEAD requests are read-only (market data, order book, etc.) and don't need protection
  if (API_KEY && req.method !== "GET" && req.method !== "HEAD" && req.headers["x-proxy-key"] !== API_KEY) {
    return reply.status(401).send({ error: "Unauthorized — invalid X-Proxy-Key" });
  }

  const targetUrl = `${CLOB_TARGET}${req.url}`;

  // Build headers — forward everything except hop-by-hop and proxy headers
  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "x-proxy-key" ||
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "transfer-encoding"
    ) continue;
    forwardHeaders[key] = value;
  }
  // Set correct Host for the target
  forwardHeaders["host"] = new URL(CLOB_TARGET).host;

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.method !== "GET" && req.method !== "HEAD"
        ? JSON.stringify(req.body)
        : undefined,
      redirect: "follow",
    });

    // Forward status + headers + body back
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      // Skip hop-by-hop headers
      if (key === "transfer-encoding" || key === "connection") return;
      responseHeaders[key] = value;
    });

    const body = await response.text();
    return reply
      .status(response.status)
      .headers(responseHeaders)
      .send(body);

  } catch (err) {
    req.log.error(err, "Proxy fetch failed");
    return reply.status(502).send({
      error: "Proxy error",
      detail: String(err),
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`CLOB proxy listening on :${PORT} → ${CLOB_TARGET}`);
});
