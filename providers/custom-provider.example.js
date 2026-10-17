"use strict";

// Copy this file to my-provider.js and implement your AI vendor's API here.
// You can use any vendor and any request/response structure. Only this adapter
// needs to understand that vendor. Return the final answer as a string (or an
// object containing answer/response/result/content/text).
//
// Available settings come from the server environment:
//   apiKey, baseUrl, model, systemPrompt, userPrompt, quiz
//
// The extension contract remains POST /api/ai -> { answer: "..." }.
async function generate({ apiKey, baseUrl, model, systemPrompt, userPrompt, quiz }) {
  void apiKey;
  void baseUrl;
  void model;
  void systemPrompt;
  void userPrompt;
  void quiz;

  throw new Error("Implement this adapter for your AI provider's API.");
}

module.exports = { generate };
