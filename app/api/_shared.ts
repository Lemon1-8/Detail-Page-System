import OpenAI from "openai";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import { normalizeApiBaseUrl } from "../../lib/api-base-url.ts";

const NO_STORE = { "Cache-Control": "no-store" };

export function isPublicAddress(address: string) {
  const parsed = ipaddr.parse(address);
  return parsed.range() === "unicast" &&
    (parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3));
}

export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
      return callback(new Error("API 地址必须解析为公网地址"), "", 4);
    }
    // 将校验过的 IP 直接交给连接层，避免再次解析 DNS。
    if (options.all) return callback(null, addresses);
    const target = addresses.find(item => item.family === 4) || addresses[0];
    callback(null, target.address, target.family);
  });
};

export const apiFetchOptions = {
  dispatcher: new Agent({ connect: { lookup: publicLookup }, autoSelectFamily: false }),
  redirect: "error" as const,
};

export async function readAIRequest(request: Request) {
  const apiKey = request.headers.get("authorization")?.match(/^Bearer ([\x21-\x7e]{1,512})$/i)?.[1];
  if (!apiKey) {
    return Response.json({ error: "请先填写您自己的 API Key" }, { status: 401, headers: NO_STORE });
  }

  let body;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > 4_000_000) {
      return Response.json({ error: "图片总体积过大，请减少图片后重试" }, { status: 413, headers: NO_STORE });
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "请求必须是有效的 JSON" }, { status: 400, headers: NO_STORE });
  }

  let apiBaseUrl;
  try {
    apiBaseUrl = normalizeApiBaseUrl(body?.apiBaseUrl);
  } catch {
    return Response.json({ error: "请填写有效的 HTTPS 模型 API 地址，仅支持公网域名" }, { status: 400, headers: NO_STORE });
  }

  if (!body || !Array.isArray(body.images) || body.images.length < 1 || body.images.length > 10 ||
      !body.images.every((image: unknown) => typeof image === "string" &&
        /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
    return Response.json({ error: "请提供 1 至 10 张有效的产品图片" }, { status: 400, headers: NO_STORE });
  }

  return { apiKey, apiBaseUrl, body: body as { images: string[]; [key: string]: unknown } };
}

export function aiErrorResponse(error: unknown, model?: string) {
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIUserAbortError) {
    return Response.json({ error: "模型服务请求超时，请稍后重试或减少图片数量" }, { status: 504, headers: NO_STORE });
  }
  if (error instanceof OpenAI.APIError && error.code === "model_not_found") {
    return Response.json({ error: `当前 Key 分组或 API 地址没有可用的 ${model || "所需模型"} 通道，请检查模型权限或更换 Key / 服务地址` }, { status: 400, headers: NO_STORE });
  }
  // 上游异常可能包含请求头或密钥，只返回固定文案，不记录原始异常。
  if (status === 401 || status === 403) {
    return Response.json({ error: "API Key 无效或没有模型访问权限，请检查后重试" }, { status: 401, headers: NO_STORE });
  }
  if (status === 429) {
    return Response.json({ error: "模型服务额度不足或请求过于频繁，请稍后重试" }, { status: 429, headers: NO_STORE });
  }
  return Response.json({ error: "模型服务请求失败，请检查 Key、模型权限或稍后重试" }, { status: 502, headers: NO_STORE });
}
