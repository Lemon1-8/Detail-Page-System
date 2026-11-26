import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { MockAgent } from "undici";
import { apiFetchOptions } from "../app/api/_shared.ts";
import { POST as analyze } from "../app/api/analyze/route.ts";
import { POST as generate } from "../app/api/generate-detail/route.ts";

// 仅验证 HTTP 协议与密钥隔离，测试图片和上游响应不用于业务验收。
const pixel = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#ffffff" } }).png().toBuffer();
const dataUrl = `data:image/png;base64,${pixel.toString("base64")}`;
const streamChunk = (content, finishReason = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n`;
const request = (host, key, extra = {}) => new Request("https://app.example/api/test", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ apiBaseUrl: `https://${host}/v1`, images: [dataUrl], ...extra }),
});

test("分析使用用户填写的地址和 Key 调用 gpt-6.1-sol Chat Completions", async () => {
  const previous = apiFetchOptions.dispatcher;
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  apiFetchOptions.dispatcher = dispatcher;
  let sent;
  dispatcher.get("https://analysis.example").intercept({
    path: "/v1/chat/completions", method: "POST", headers: { authorization: "Bearer test-analysis-key" },
  }).reply(200, options => {
    sent = JSON.parse(options.body);
    return streamChunk('{"title":"协议测试",') + streamChunk('"subtitle":"模拟响应"}', "stop") + "data: [DONE]\n\n";
  }, { headers: { "content-type": "text/event-stream" } });
  try {
    const response = await analyze(request("analysis.example", "test-analysis-key"));
    assert.equal(response.status, 200);
    assert.equal(sent.model, "gpt-6.1-sol");
    assert.equal(sent.max_completion_tokens, 4096);
    assert.equal(sent.stream, true);
    assert.equal(sent.messages[1].content[1].image_url.url, dataUrl);
    assert.equal(sent.response_format.type, "json_object");
    assert.equal((await response.json()).title, "协议测试");
    dispatcher.assertNoPendingInterceptors();
  } finally {
    apiFetchOptions.dispatcher = previous;
    await dispatcher.close();
  }
});

test("分析内容被截断时明确报错，不将残缺 JSON 当作可用文案", async () => {
  const previous = apiFetchOptions.dispatcher;
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  apiFetchOptions.dispatcher = dispatcher;
  dispatcher.get("https://analysis.example").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, streamChunk("{", "length") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  try {
    const response = await analyze(request("analysis.example", "test-analysis-key"));
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error.includes("不完整"));
  } finally {
    apiFetchOptions.dispatcher = previous;
    await dispatcher.close();
  }
});

test("gpt-image-2 使用 multipart 图片编辑接口，单张图也能生成材质模块", async () => {
  const previous = apiFetchOptions.dispatcher;
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  apiFetchOptions.dispatcher = dispatcher;
  const output = await sharp(pixel).jpeg().toBuffer();
  let multipart;
  dispatcher.get("https://images.example").intercept({
    path: "/v1/images/edits", method: "POST",
    headers: { authorization: "Bearer test-image-key", "content-type": /multipart\/form-data/ },
  }).reply(200, options => {
    multipart = options.body;
    return { data: [{ b64_json: output.toString("base64") }] };
  }, { headers: { "content-type": "application/json" } });
  try {
    const response = await generate(request("images.example", "test-image-key", { screenType: "material", analysis: {} }));
    assert.equal(response.status, 200);
    assert.equal(multipart.get("model"), "gpt-image-2");
    assert.equal(multipart.get("image[]").name, "reference-0.jpg");
    assert.equal(multipart.get("image[]").type, "image/jpeg");
    assert.equal(multipart.get("size"), "1024x1536");
    assert.equal(multipart.has("apiKey"), false);
    const result = await response.json();
    assert.equal(result.image, `data:image/jpeg;base64,${output.toString("base64")}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    dispatcher.assertNoPendingInterceptors();
  } finally {
    apiFetchOptions.dispatcher = previous;
    await dispatcher.close();
  }
});
