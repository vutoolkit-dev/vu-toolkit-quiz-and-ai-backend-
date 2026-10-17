"use strict";

// Default adapter for providers that expose the OpenAI chat-completions shape.
async function generate({ apiKey, baseUrl, model, systemPrompt, userPrompt }) {
  if (!apiKey) throw Object.assign(new Error("AI_API_KEY is not configured on the server."), { status: 503 });
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("AI provider returned HTTP", response.status, body?.error?.message || "");
    throw Object.assign(new Error(`AI provider request failed (${response.status}).`), { status: 502 });
  }

  return body?.choices?.[0]?.message?.content;
}

module.exports = { generate };
