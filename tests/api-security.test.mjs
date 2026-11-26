import assert from "node:assert/strict";
import { test, mock } from "node:test";
import dns from "node:dns";
import OpenAI from "openai";
import { MockAgent } from "undici";
import { readAIRequest, aiErrorResponse, isPublicAddress, publicLookup, apiFetchOptions } from "../app/api/_shared.ts";
import { requestAI } from "../lib/api-request.ts";
import { DEFAULT_API_BASE_URL, normalizeApiBaseUrl } from "../lib/api-base-url.ts";

// 仅使用测试凭据和最小图片标记，不调用真实模型或产生费用。
const image = "data:image/png;base64,aGVsbG8=";
const makeRequest = (key, body = {}) => new Request("https://example.test/api/analyze", {
  method: "POST",
  headers: key ? { Authorization: `Bearer ${key}` } : {},
  body: JSON.stringify({ images: [image], apiBaseUrl: DEFAULT_API_BASE_URL, ...body }),
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
    readAIRequest(makeRequest("test-user-a", { apiBaseUrl: "https://one.example/v1" })),
    readAIRequest(makeRequest("test-user-b", { apiBaseUrl: "https://two.example/v1" })),
  ]);
  assert.equal(first.apiKey, "test-user-a");
  assert.equal(second.apiKey, "test-user-b");
  assert.equal(first.apiBaseUrl, "https://one.example/v1");
  assert.equal(second.apiBaseUrl, "https://two.example/v1");
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
    await requestAI("/api/analyze", " test-user-key ", { images: [image] }, "https://custom.example/v1/");
    const [path, options] = calls[0];
    assert.equal(path, "/api/analyze");
    assert.equal(options.headers.Authorization, "Bearer test-user-key");
    assert.equal(options.body.includes("test-user-key"), false);
    assert.equal(JSON.parse(options.body).apiBaseUrl, "https://custom.example/v1");
    assert.equal(options.cache, "no-store");
    await assert.rejects(requestAI("/api/analyze", "", {}, DEFAULT_API_BASE_URL), /API Key/);
    await assert.rejects(requestAI("/api/analyze", "test-user-key", { extra: "x".repeat(4_000_000) }, DEFAULT_API_BASE_URL), /体积过大/);
    await assert.rejects(requestAI("/api/analyze", "test-user-key", {}, "http://localhost"), /HTTPS/);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => new Response("Payload Too Large", { status: 413 });
    await assert.rejects(requestAI("/api/analyze", "test-user-key", {}, DEFAULT_API_BASE_URL), /体积过大/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("地址默认值与规范化，拒绝本机、IP、非 HTTPS 及 URL 中的凭据", async () => {
  assert.equal(DEFAULT_API_BASE_URL, "https://www.boxying.com/v1");
  assert.equal(normalizeApiBaseUrl(" https://custom.example:8443/api/v1/// "), "https://custom.example:8443/api/v1");
  for (const value of [undefined, "", "file:///etc/passwd", "http://api.example/v1", "https://localhost/v1",
    "https://sub.localhost/v1", "https://127.0.0.1/v1", "https://2130706433/v1", "https://0x7f000001/v1",
    "https://[::1]/v1", "https://user:secret@api.example/v1", "https://api.example/v1?key=secret", "https://api.example/v1#key"]) {
    assert.throws(() => normalizeApiBaseUrl(value));
    assert.equal((await readAIRequest(makeRequest("test-key", { apiBaseUrl: value }))).status, 400);
  }
});

test("公网 IPv4/IPv6 可访问，内网、元数据及保留地址被拒绝", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "fc00::1", "fe80::1",
    "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "4000::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("连接层使用校验过的 DNS 结果，并拒绝内网和混合解析", async () => {
  let answers = [{ address: "8.8.8.8", family: 4 }];
  const mocked = mock.method(dns, "lookup", (_hostname, _options, callback) => callback(null, answers));
  const resolve = (options = {}) => new Promise((resolve, reject) => {
    publicLookup("api.example.test", options, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  try {
    assert.deepEqual(await resolve(), { address: "8.8.8.8", family: 4 });
    assert.deepEqual((await resolve({ all: true })).address, answers);
    answers = [{ address: "127.0.0.1", family: 4 }];
    await assert.rejects(resolve(), /公网/);
    await assert.rejects(fetch("https://api.example.test/v1", { ...apiFetchOptions, method: "POST", body: "{}" }),
      error => error.cause?.message.includes("公网"));
    answers = [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }];
    await assert.rejects(resolve(), /公网/);
  } finally {
    mocked.mock.restore();
  }
});

test("不跟随模型服务的重定向，防止密钥被转发到其他地址", async () => {
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  dispatcher.get("https://api.example.test").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(307, "", { headers: { location: "https://elsewhere.example/private" } });
  try {
    await assert.rejects(fetch("https://api.example.test/v1/chat/completions", {
      ...apiFetchOptions, dispatcher, method: "POST", body: "{}", headers: { Authorization: "Bearer test-only-key" },
    }));
    dispatcher.assertNoPendingInterceptors();
  } finally {
    await dispatcher.close();
  }
});
