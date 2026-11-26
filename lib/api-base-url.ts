export const DEFAULT_API_BASE_URL = "https://www.boxying.com/v1";

export function normalizeApiBaseUrl(value: unknown): string {
  const message = "请填写 HTTPS 模型 API 地址，不支持 IP 地址、账号密码、查询参数或片段";
  if (typeof value !== "string" || value.length > 2048) throw new Error(message);

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(message);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.hostname.includes(":") || /^[\d.]+$/.test(url.hostname) ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error(message);
  }
  return url.href.replace(/\/+$/, "");
}
