import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "./server.mjs";

async function withServer(run) {
  const server = createAppServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function post(base, text) {
  const response = await fetch(`${base}/api/triage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return { status: response.status, body: await response.json() };
}

test("valid AI output is returned as ready", () => withServer(async base => {
  const result = await post(base, "Какая цена товара?");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    status: "ready", topic: "pricing", draft: "Спасибо за обращение. Уточним детали заявки.",
  });
}));

test("invalid input produces 400", () => withServer(async base => {
  for (const value of ["  ", null, 123, undefined]) {
    assert.deepEqual(await post(base, value), { status: 400, body: { status: "invalid_input" } });
  }
  const response = await fetch(`${base}/api/triage`, { method: "POST", body: "{broken" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
}));

test("AI errors and invalid outputs require manual review", () => withServer(async base => {
  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    assert.deepEqual(await post(base, marker), {
      status: 200, body: { status: "manual_review", topic: null, draft: null },
    });
  }
}));

test("AI timeout returns manual review within deadline", () => withServer(async base => {
  const start = performance.now();
  const result = await post(base, "[timeout]");
  assert.deepEqual(result, { status: 200, body: { status: "manual_review", topic: null, draft: null } });
  assert.ok(performance.now() - start < 1000, "timeout should not wait 1200ms for AI");
}));
