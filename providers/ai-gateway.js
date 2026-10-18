"use strict";

// Adapter for the tested Vercel AI Gateway Messages API.
async function generate({ apiKey, baseUrl, model, userPrompt, images = [] }) {
  if (!apiKey) throw Object.assign(new Error("AI_API_KEY is not configured on the server."), { status: 503 });

  const configuredMaxTokens = Number(process.env.AI_MAX_TOKENS || 8192);
  const maxTokens = Number.isInteger(configuredMaxTokens) && configuredMaxTokens > 0
    ? configuredMaxTokens
    : 8192;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/messages`;
  const content = [{ type: "text", text: userPrompt }];
  images.forEach((image, index) => {
    const label = image.label || (index === 0 ? "Question" : `Option ${String.fromCharCode(64 + index)}`);
    content.push({ type: "text", text: `${label}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    });
  });

  const response = await fetch(endpoint, {
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

  if (!response.ok) {
    console.error("AI Gateway returned HTTP", response.status, body?.error?.message || "");
    throw Object.assign(new Error(`AI provider request failed (${response.status}).`), { status: 502 });
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
    console.error("AI Gateway returned no text content.", {
      topLevelKeys: Object.keys(body || {}),
      contentTypes: Array.isArray(body?.content) ? body.content.map((block) => block?.type || "unknown") : [],
    });
  }
  return answer || null;
}

module.exports = { generate };
