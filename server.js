"use strict";

// VU quiz AI API. The browser extension always calls this endpoint; choose or
// replace the AI provider here using environment variables without changing it.
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const AI_PROVIDER_MODULE = process.env.AI_PROVIDER_MODULE || "./providers/openai-compatible.js";
const AI_PROVIDER_PATH = path.resolve(__dirname, AI_PROVIDER_MODULE);
const aiProvider = require(AI_PROVIDER_PATH);
const AI_BASE_URL = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const AI_API_KEY = process.env.AI_API_KEY || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || [
  "Solve the provided multiple-choice quiz question accurately.",
  "Explain the reasoning briefly and clearly.",
  "End with exactly: The correct option is X. Replace X with the option letter.",
].join(" ");
const MAX_BODY_BYTES = 128 * 1024;
let quizSaveQueue = Promise.resolve();

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function makeUserPrompt(quiz) {
  const options = Array.isArray(quiz.options)
    ? quiz.options.map((option, index) => {
      const rawText = option && typeof option === "object"
        ? option.text ?? option.value ?? option.content ?? ""
        : option;
      const labeledText = typeof rawText === "string" ? rawText.match(/^\s*([A-D])\.\s*(.*)$/i) : null;
      const letter = option && typeof option === "object" && option.letter
        ? String(option.letter)
        : labeledText?.[1]?.toUpperCase() || String.fromCharCode(65 + index);
      const text = labeledText ? labeledText[2] : rawText;
      return `${letter}. ${text}`;
    }).join("\n")
    : "";
  return [
    quiz.course ? `Course: ${quiz.course}` : "",
    quiz.quizNo != null ? `Quiz: ${quiz.quizNo}` : "",
    quiz.date ? `Date: ${quiz.date}` : "",
    `Question: ${quiz.question.trim()}`,
    options ? `Options:\n${options}` : "",
  ].filter(Boolean).join("\n\n");
}

function getQuizRecordId(quiz) {
  const options = normalizedOptions(quiz.options);
  const normalized = [
    String(quiz.course || "").trim().toLowerCase(),
    String(quiz.quizNo || "").trim().toLowerCase(),
    String(quiz.question || "").trim().replace(/\s+/g, " ").toLowerCase(),
    ...options,
  ];
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizedValue(value) {
  return value == null ? "" : String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function formatQuizDate(value) {
  if (!value) return value;
  // Already-human-readable quiz dates are labels, not timestamps. Preserve
  // them as-is so parsing them in the server's timezone cannot shift a day.
  if (/^\d{1,2} [A-Za-z]+ \d{4}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).format(parsed);
}

function formatPakistanTimestamp(value) {
  // This is the format emitted below. Never parse it as server-local time and
  // apply the Pakistan offset again on later saves.
  if (typeof value === "string" && /^\d{1,2} [A-Za-z]+ \d{4}, \d{2}:\d{2}:\d{2} (AM|PM)$/.test(value)) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(parsed);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod").toUpperCase()}`;
}

function normalizedOptions(options) {
  return Array.isArray(options) ? options.map((option) => {
    const rawText = option && typeof option === "object"
      ? option.text ?? option.value ?? option.content
      : option;
    return normalizedValue(rawText).replace(/^[a-d]\.\s*/i, "");
  }).filter(Boolean) : [];
}

function labelOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option, index) => {
    const rawText = option && typeof option === "object"
      ? option.text ?? option.value ?? option.content ?? ""
      : option;
    const labeledText = typeof rawText === "string" ? rawText.trim().match(/^([A-D])\.\s*(.*)$/i) : null;
    const letter = option && typeof option === "object" && option.letter
      ? String(option.letter).trim().toUpperCase()
      : labeledText?.[1]?.toUpperCase() || String.fromCharCode(65 + index);
    const text = String(labeledText ? labeledText[2] : rawText ?? "").trim();
    return text ? `${letter}. ${text}` : "";
  }).filter(Boolean);
}

function canMergeQuizRecord(existing, incoming) {
  if (normalizedValue(existing.question) !== normalizedValue(incoming.question)) return false;

  for (const field of ["course", "quizNo"]) {
    const oldValue = normalizedValue(existing[field]);
    const newValue = normalizedValue(incoming[field]);
    if (oldValue && newValue && oldValue !== newValue) return false;
  }

  const oldOptions = normalizedOptions(existing.options);
  const newOptions = normalizedOptions(incoming.options);

  // A quiz can contain repeated generic prompts. Require complete, matching
  // options to use this fuzzy match; course/quiz number alone identifies the
  // quiz, not the individual question within it.
  if (!oldOptions.length || !newOptions.length) return false;
  return JSON.stringify(oldOptions) === JSON.stringify(newOptions);
}

function quizMatchScore(existing, incoming) {
  let score = 0;
  for (const field of ["course", "quizNo"]) {
    if (normalizedValue(existing[field]) && normalizedValue(existing[field]) === normalizedValue(incoming[field])) score++;
  }
  const oldOptions = normalizedOptions(existing.options);
  const newOptions = normalizedOptions(incoming.options);
  if (oldOptions.length && newOptions.length && JSON.stringify(oldOptions) === JSON.stringify(newOptions)) score++;
  return score;
}

async function supabaseRequest(url, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw Object.assign(new Error("Supabase is not configured on the server."), { status: 503 });
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) {
    console.error("Supabase request failed:", response.status, typeof data === "string" ? data : JSON.stringify(data));
    throw Object.assign(new Error("Supabase could not save the quiz record."), { status: 502 });
  }
  return data;
}

async function saveQuizRecord(quiz) {
  const operation = quizSaveQueue.then(async () => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw Object.assign(new Error("Supabase is not configured on the server."), { status: 503 });
    }
    const questionKey = normalizedValue(quiz.question);
    const queryUrl = new URL(`${SUPABASE_URL}/rest/v1/quiz_questions`);
    queryUrl.searchParams.set("select", "*");
    queryUrl.searchParams.set("question_key", `eq.${questionKey}`);
    queryUrl.searchParams.set("limit", "1000");
    const storedRows = await supabaseRequest(queryUrl);
    const records = (Array.isArray(storedRows) ? storedRows : []).map((row) => ({
      id: row.id,
      question: row.question,
      options: row.options,
      course: row.course,
      date: formatQuizDate(row.date),
      quizNo: row.quiz_no,
      createdAt: formatPakistanTimestamp(row.created_at),
      updatedAt: formatPakistanTimestamp(row.updated_at),
    }));

    const now = formatPakistanTimestamp(new Date());

    const incomingHasOptions = normalizedOptions(quiz.options).length > 0;
    let index = incomingHasOptions
      ? records.findIndex((record) => record.id === getQuizRecordId(quiz))
      : -1;
    if (index < 0 && incomingHasOptions) {
      const compatible = records
        .map((record, recordIndex) => ({ record, recordIndex }))
        .filter(({ record }) => canMergeQuizRecord(record, quiz))
        .sort((a, b) => quizMatchScore(b.record, quiz) - quizMatchScore(a.record, quiz));
      if (compatible.length) {
        const bestScore = quizMatchScore(compatible[0].record, quiz);
        const equallyGood = compatible.filter(({ record }) => quizMatchScore(record, quiz) === bestScore);
        // If several old records fit equally well, do not guess which one to overwrite.
        if (equallyGood.length === 1) index = compatible[0].recordIndex;
      }
    }

    const previous = index >= 0 ? records[index] : null;
    const chooseValue = (newValue, oldValue) =>
      newValue != null && String(newValue).trim() !== "" ? newValue : oldValue ?? null;
    const incomingOptions = normalizedOptions(quiz.options).length
      ? labelOptions(quiz.options)
      : previous?.options ?? [];
    const record = {
      id: "",
      question: quiz.question.trim(),
      options: incomingOptions,
      course: chooseValue(quiz.course, previous?.course),
      // Date is saved as metadata but deliberately does not identify a quiz.
      // Store the latest observed quiz date, but never use it for matching.
      date: chooseValue(formatQuizDate(quiz.date), previous?.date),
      quizNo: chooseValue(quiz.quizNo, previous?.quizNo),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    // Incomplete questions cannot be reliably deduplicated. Give each a unique
    // ID so identical generic prompts with no options do not collide by hash.
    record.id = previous?.id || (normalizedOptions(record.options).length
      ? getQuizRecordId(record)
      : crypto.randomUUID());

    const contentFields = ({ question, options, course, date, quizNo }) =>
      JSON.stringify({ question, options, course, date, quizNo });
    const isUnchanged = previous && contentFields(previous) === contentFields(record);
    if (isUnchanged) {
      return { id: previous.id, saved: true, updated: false };
    }

    const upsertUrl = new URL(`${SUPABASE_URL}/rest/v1/quiz_questions`);
    upsertUrl.searchParams.set("on_conflict", "id");
    await supabaseRequest(upsertUrl, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: record.id,
        question: record.question,
        question_key: questionKey,
        options: record.options,
        course: record.course,
        date: record.date,
        quiz_no: record.quizNo,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      }),
    });
    return { id: record.id, saved: true, updated: !isUnchanged };
  });

  quizSaveQueue = operation.catch(() => {});
  return operation;
}

async function solveQuiz(quiz) {
  if (typeof aiProvider.generate !== "function") {
    throw Object.assign(new Error("Selected provider module must export generate()."), { status: 500 });
  }

  const result = await aiProvider.generate({
    apiKey: AI_API_KEY,
    baseUrl: AI_BASE_URL,
    model: AI_MODEL,
    systemPrompt: AI_SYSTEM_PROMPT,
    userPrompt: makeUserPrompt(quiz),
    quiz,
  });

  // Normalize provider output. Every adapter may return plain text or a common
  // answer field; the extension always receives the stable `{ answer }` shape.
  const extractAnswer = (value, depth = 0) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object" || depth > 5) return null;
    for (const key of ["answer", "response", "result", "content", "text", "output", "message", "data"]) {
      if (value[key] != null) {
        const candidate = extractAnswer(value[key], depth + 1);
        if (candidate) return candidate;
      }
    }
    return null;
  };
  const answer = extractAnswer(result);
  if (typeof answer !== "string" || !answer.trim()) {
    throw Object.assign(new Error("AI provider returned no answer text."), { status: 502 });
  }
  return answer.trim();
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
    response.end();
    return;
  }

  if (pathname === "/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if ((pathname !== "/api/ai" && pathname !== "/api/quiz") || request.method !== "POST") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  try {
    const quiz = await readJson(request);
    if (!quiz || typeof quiz !== "object" || Array.isArray(quiz) || typeof quiz.question !== "string" || !quiz.question.trim()) {
      sendJson(response, 400, { error: "A non-empty question is required." });
      return;
    }

    if (pathname === "/api/quiz") {
      const result = await saveQuizRecord(quiz);
      sendJson(response, 200, result);
      return;
    }

    const answer = await solveQuiz(quiz);
    // Stable response contract consumed by the extension. Prompt/model/output
    // can all be changed server-side while keeping this `{ answer }` response.
    sendJson(response, 200, { answer });
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error.status || 500, { error: error.message || "AI request failed." });
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`VU Quiz AI API listening on port ${PORT}`);
});
