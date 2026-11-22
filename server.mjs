import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const TOPICS = new Set(["delivery", "pricing", "other"]);
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const INVALID_INPUT = { status: "invalid_input" };
const MODEL_TIMEOUT_MS = 300;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readInput(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 64 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.text !== "string" || !body.text.trim()) {
      return null;
    }
    return body.text.trim();
  } catch {
    return null;
  }
}

async function getModelResult(text) {
  const controller = new AbortController();
  let timer;
  try {
    // The deadline must reject even when an upstream provider ignores abort.
    const output = await Promise.race([
      classify(text, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Model timeout"));
        }, MODEL_TIMEOUT_MS);
      }),
    ]);
    const value = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !TOPICS.has(value.topic) || typeof value.draft !== "string" || !value.draft.trim()) {
      return MANUAL_REVIEW;
    }
    return { status: "ready", topic: value.topic, draft: value.draft.trim() };
  } catch {
    return MANUAL_REVIEW;
  } finally {
    clearTimeout(timer);
  }
}

export function createAppServer() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      json(response, 404, { status: "not_found" });
      return;
    }
    try {
      const text = await readInput(request);
      if (text === null) {
        json(response, 400, INVALID_INPUT);
        return;
      }
      json(response, 200, await getModelResult(text));
    } catch {
      // Transport-level failures are not valid AI results.
      if (!response.headersSent) json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAppServer().listen(Number(process.env.PORT || 3000), "127.0.0.1", () => {
    console.log(`Triage running at http://127.0.0.1:${process.env.PORT || 3000}`);
  });
}
