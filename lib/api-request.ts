export async function requestAI(path: string, apiKey: string, payload: unknown) {
  const key = apiKey.trim();
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) {
    throw new Error("请先填写有效的 API Key");
  }

  const body = JSON.stringify(payload);
  if (new Blob([body]).size > 4_000_000) {
    throw new Error("图片总体积过大，请减少图片后重试");
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body,
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.error || (response.status === 413
      ? "图片总体积过大，请减少图片后重试"
      : "请求失败或超时，请稍后重试"));
  }
  return data;
}
