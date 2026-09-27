import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const port = 18_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
let child;

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("Test API did not start");
}

function rawPathStatus(path) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "GET", path }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

before(async () => {
  child = spawn(process.execPath, ["scripts/api-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ADMIN_TOKEN: "integration-test-token",
      MAX_REQUEST_BYTES: "512",
      RATE_LIMIT: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
});

after(() => {
  child?.kill();
});

test("health and static frontend responses include defensive headers", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const frontend = await fetch(`${baseUrl}/`);
  assert.equal(frontend.status, 200);
  assert.equal(frontend.headers.get("x-content-type-options"), "nosniff");
  assert.equal(frontend.headers.get("x-frame-options"), "DENY");
  const contentSecurityPolicy = frontend.headers.get("content-security-policy") || "";
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
  assert.match(contentSecurityPolicy, /img-src[^;]*https:\/\/image\.pollinations\.ai/);
  assert.match(contentSecurityPolicy, /connect-src[^;]*https:\/\/image\.pollinations\.ai/);
  assert.equal(await rawPathStatus("/%2e%2e%2f.env"), 403);
});

test("chat endpoint rejects wrong methods and malformed body shapes", async () => {
  assert.equal((await fetch(`${baseUrl}/api/chat`)).status, 405);

  const nullBody = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });
  assert.equal(nullBody.status, 400);
  assert.match((await nullBody.json()).error, /JSON object/i);

  const wrongType = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
});

test("chat endpoint returns bounded validation errors", async () => {
  const tooLarge = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(600) }),
  });
  assert.equal(tooLarge.status, 413);

  const tooManyAttachments = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "read", attachments: [{}, {}, {}, {}] }),
  });
  assert.equal(tooManyAttachments.status, 400);

  const badSession = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello", sessionId: "bad session\nvalue" }),
  });
  assert.equal(badSession.status, 400);
});

test("admin settings reject invalid crawler configuration without saving it", async () => {
  const headers = { "content-type": "application/json", "x-admin-token": "integration-test-token" };
  const invalidNumber = await fetch(`${baseUrl}/api/admin/settings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ maxPages: "many", crawlConcurrency: 10 }),
  });
  assert.equal(invalidNumber.status, 400);

  const invalidUrl = await fetch(`${baseUrl}/api/admin/settings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ officialSiteUrl: "file:///etc/passwd", maxPages: 10, crawlConcurrency: 2 }),
  });
  assert.equal(invalidUrl.status, 400);
});
