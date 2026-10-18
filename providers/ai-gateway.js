"use strict";

// Adapter for the tested Vercel AI Gateway Messages API.
async function generate({ apiKey, baseUrl, model, userPrompt, images = [], requestId = "no-id" }) {
  if (!apiKey) throw Object.assign(new Error("AI_API_KEY is not configured on the server."), { status: 503 });

  const configuredMaxTokens = Number(process.env.AI_MAX_TOKENS || 8192);
  const maxTokens = Number.isInteger(configuredMaxTokens) && configuredMaxTokens > 0
    ? configuredMaxTokens
    : 8192;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/messages`;
  // Preserve the previously working Messages request shape for text-only
  // quizzes. Switch to content blocks only when there are actual images.
  const content = images.length ? [{ type: "text", text: userPrompt }] : userPrompt;
  if (images.length) {
    images.forEach((image, index) => {
      const label = image.label || (index === 0 ? "Question" : `Option ${String.fromCharCode(64 + index)}`);
      content.push({ type: "text", text: `${label}:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      });
    });
  }

  const startedAt = Date.now();
  console.info(`[request:${requestId}] AI Gateway request started`, {
    model,
    maxTokens,
    messageContentShape: images.length ? "blocks" : "string",
    imageCount: images.length,
    imageTypes: images.map((image) => image.mediaType),
    imageBytes: images.reduce((sum, image) => sum + Buffer.from(image.data, "base64").length, 0),
    promptChars: userPrompt.length,
  });
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[request:${requestId}] AI Gateway network request failed`, {
      durationMs: Date.now() - startedAt,
      name: error.name || "Error",
      message: error.message || "Network request failed.",
    });
    throw error;
  }

  const responseText = await response.text();
  let body = {};
  try {
    body = JSON.parse(responseText);
  } catch {
    console.error("AI Gateway returned a non-JSON response.", {
      status: response.status,
      contentType: response.headers.get("content-type") || "unknown",
      bodyLength: responseText.length,
    });
  }

  console.info(`[request:${requestId}] AI Gateway response received`, {
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    contentType: response.headers.get("content-type") || "unknown",
    topLevelKeys: Object.keys(body || {}),
    contentTypes: Array.isArray(body?.content) ? body.content.map((block) => block?.type || "unknown") : [],
  });

  if (!response.ok) {
    const providerMessage = String(body?.error?.message || body?.message || "").slice(0, 500);
    console.error(`[request:${requestId}] AI Gateway returned HTTP error`, {
      status: response.status,
      message: providerMessage,
    });
    const detail = providerMessage ? `: ${providerMessage}` : ".";
    throw Object.assign(new Error(`AI provider request failed (${response.status})${detail}`), { status: 502 });
  }

  // The Messages API can return both text and thinking blocks. Only pass the
  // user-facing text blocks to the extension.
  const answer = Array.isArray(body?.content)
    ? body.content.filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim()
    : typeof body?.content === "string"
      ? body.content.trim()
      : "";

  if (!answer) {
    console.error(`[request:${requestId}] AI Gateway returned no text content`, {
      topLevelKeys: Object.keys(body || {}),
      contentTypes: Array.isArray(body?.content) ? body.content.map((block) => block?.type || "unknown") : [],
    });
  } else {
    console.info(`[request:${requestId}] AI Gateway text extracted`, { answerChars: answer.length });
  }
  return answer || null;
}

module.exports = { generate };
