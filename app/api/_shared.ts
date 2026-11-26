import OpenAI from "openai";

const NO_STORE = { "Cache-Control": "no-store" };

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

  if (!body || !Array.isArray(body.images) || body.images.length < 1 || body.images.length > 10 ||
      !body.images.every((image: unknown) => typeof image === "string" &&
        /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
    return Response.json({ error: "请提供 1 至 10 张有效的产品图片" }, { status: 400, headers: NO_STORE });
  }

  return { apiKey, body: body as { images: string[]; [key: string]: unknown } };
}

export function aiErrorResponse(error: unknown) {
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  // 上游异常可能包含请求头或密钥，只返回固定文案，不记录原始异常。
  if (status === 401 || status === 403) {
    return Response.json({ error: "API Key 无效或没有模型访问权限，请检查后重试" }, { status: 401, headers: NO_STORE });
  }
  if (status === 429) {
    return Response.json({ error: "模型服务额度不足或请求过于频繁，请稍后重试" }, { status: 429, headers: NO_STORE });
  }
  return Response.json({ error: "模型服务请求失败，请检查 Key、模型权限或稍后重试" }, { status: 502, headers: NO_STORE });
}
