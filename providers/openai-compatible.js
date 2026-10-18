"use strict";

// Default adapter for providers that expose the OpenAI chat-completions shape.
async function generate({ apiKey, baseUrl, model, systemPrompt, userPrompt }) {
  if (!apiKey) throw Object.assign(new Error("AI_API_KEY is not configured on the server."), { status: 503 });
  const configuredMaxTokens = Number(process.env.AI_MAX_TOKENS || 8192);
  const maxTokens = Number.isInteger(configuredMaxTokens) && configuredMaxTokens > 0
    ? configuredMaxTokens
    : 8192;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (new URL(baseUrl).hostname === "agentrouter.org") {
    // Match the headers used by the successful AgentRouter diagnostic client.
    Object.assign(headers, {
      "User-Agent": "claude-cli/1.0.60 (external, cli)",
      "x-app": "cli",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
    });
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const responseText = await response.text();
  let body = {};
  try {
    body = JSON.parse(responseText);
  } catch {
    console.error("AI provider returned a non-JSON response.", {
      status: response.status,
      contentType: response.headers.get("content-type") || "unknown",
      bodyLength: responseText.length,
    });
  }
  if (!response.ok) {
    console.error("AI provider returned HTTP", response.status, body?.error?.message || "");
    throw Object.assign(new Error(`AI provider request failed (${response.status}).`), { status: 502 });
  }

  // OpenAI-compatible vendors sometimes return message content as text blocks
  // instead of a single string, or use one of the common response fields.
  const extractText = (value, depth = 0) => {
    if (depth > 6 || value == null) return null;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value.map((item) => extractText(item, depth + 1)).filter(Boolean);
      return parts.length ? parts.join("\n") : null;
    }
    if (typeof value !== "object") return null;
    for (const key of ["text", "content", "output_text", "answer", "response", "result", "output", "message", "data"]) {
      if (value[key] != null) {
        const text = extractText(value[key], depth + 1);
        if (text) return text;
      }
    }
    return null;
  };

  const answer = extractText(body?.choices?.[0]?.message?.content)
    || extractText(body?.choices?.[0]?.text)
    || extractText(body?.output_text)
    || extractText(body?.answer)
    || extractText(body?.response)
    || extractText(body?.result)
    || extractText(body?.content);

  if (!answer) {
    console.error("AI provider returned no recognized text field.", {
      topLevelKeys: Object.keys(body || {}),
      choiceKeys: Object.keys(body?.choices?.[0] || {}),
      messageKeys: Object.keys(body?.choices?.[0]?.message || {}),
    });
  }
  return answer;
}

module.exports = { generate };
