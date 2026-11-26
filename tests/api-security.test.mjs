import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { readAIRequest, aiErrorResponse } from "../app/api/_shared.ts";
import { requestAI } from "../lib/api-request.ts";

// 仅使用测试凭据和最小图片标记，不调用真实模型或产生费用。
const image = "data:image/png;base64,aGVsbG8=";
const makeRequest = (key, body = { images: [image] }) => new Request("https://example.test/api/analyze", {
  method: "POST",
  headers: key ? { Authorization: `Bearer ${key}` } : {},
  body: JSON.stringify(body),
});

test("缺少用户 Key 时拒绝请求，即使服务器配置了共享 Key", async () => {
  const previous = process.env.API_KEY;
  process.env.API_KEY = "test-server-secret";
  try {
    const response = await readAIRequest(makeRequest());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  }
});

test("并发访客的 Key 只属于各自请求", async () => {
  const [first, second] = await Promise.all([
    readAIRequest(makeRequest("test-user-a")),
    readAIRequest(makeRequest("test-user-b")),
  ]);
  assert.equal(first.apiKey, "test-user-a");
  assert.equal(second.apiKey, "test-user-b");
  assert.equal(first.body.apiKey, undefined);
  assert.equal(second.body.apiKey, undefined);
});

test("非法 JSON、远程图片地址、超量和超大图片请求均被拒绝", async () => {
  const invalidJSON = new Request("https://example.test/api/analyze", {
    method: "POST", headers: { Authorization: "Bearer test-user" }, body: "{",
  });
  assert.equal((await readAIRequest(invalidJSON)).status, 400);
  for (const images of [[], ["https://127.0.0.1/private"], [null], Array(11).fill(image)]) {
    assert.equal((await readAIRequest(makeRequest("test-user", { images }))).status, 400);
  }
  assert.equal((await readAIRequest(makeRequest("test-user", { images: [image], extra: "x".repeat(4_000_000) }))).status, 413);
});

test("上游异常中的 Key 不会出现在返回值或日志里", async () => {
  const secret = "test-credential-must-not-leak";
  const previous = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    for (const status of [401, 403, 429, 500]) {
      const error = new OpenAI.APIError(status, { message: secret }, secret, new Headers());
      const response = aiErrorResponse(error);
      assert.equal(response.status, status === 403 ? 401 : status === 500 ? 502 : status);
      assert.equal((await response.text()).includes(secret), false);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal(logged.length, 0);
  } finally {
    console.error = previous;
  }
});

test("浏览器只将 Key 放入请求头，且能处理 Vercel 的非 JSON 错误", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return Response.json({ title: "test" });
  };
  try {
    await requestAI("/api/analyze", " test-user-key ", { images: [image] });
    const [path, options] = calls[0];
    assert.equal(path, "/api/analyze");
    assert.equal(options.headers.Authorization, "Bearer test-user-key");
    assert.equal(options.body.includes("test-user-key"), false);
    assert.equal(options.cache, "no-store");
    await assert.rejects(requestAI("/api/analyze", "", {}), /API Key/);
    await assert.rejects(requestAI("/api/analyze", "test-user-key", { extra: "x".repeat(4_000_000) }), /体积过大/);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => new Response("Payload Too Large", { status: 413 });
    await assert.rejects(requestAI("/api/analyze", "test-user-key", {}), /体积过大/);
  } finally {
    globalThis.fetch = previous;
  }
});
