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
import { Readable } from "node:stream";

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024, // 10 MB
});

const CLOB_TARGET = process.env.CLOB_TARGET || "https://clob.polymarket.com";
const API_KEY = process.env.API_KEY || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

// ── Health check ──────────────────────────────────────────────────────────
app.get("/health", async () => ({ status: "ok", region: "eu", target: CLOB_TARGET }));

// ── Accept raw body for non-JSON content types ────────────────────────────
app.addContentTypeParser("*", function (_request, payload, done) {
  let data = "";
  payload.on("data", (chunk) => { data += chunk; });
  payload.on("end", () => { done(null, data); });
});

// ── Catch-all proxy ───────────────────────────────────────────────────────
app.all("/*", async (req, reply) => {
  // Optional API key check — only enforce on write requests (POST/PUT/DELETE)
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
      lower === "transfer-encoding" ||
      lower === "content-length"
    ) continue;
    forwardHeaders[key] = value;
  }
  forwardHeaders["host"] = new URL(CLOB_TARGET).host;

  // Build request body for non-GET/HEAD
  let requestBody = undefined;
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    requestBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    forwardHeaders["content-type"] = forwardHeaders["content-type"] || "application/json";
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: requestBody,
      redirect: "follow",
    });

    // Forward response headers (skip problematic ones)
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "transfer-encoding" || lower === "connection" || lower === "content-encoding") return;
      responseHeaders[key] = value;
    });

    // Stream the response body instead of buffering the whole thing
    reply.status(response.status).headers(responseHeaders);

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body);
      return reply.send(nodeStream);
    } else {
      return reply.send("");
    }

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
