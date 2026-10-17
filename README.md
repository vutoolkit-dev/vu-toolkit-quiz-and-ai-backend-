# VU Quiz AI backend

This server provides two stable endpoints used by the browser extension:

- `POST /api/ai` solves a quiz and returns `{ "answer": "..." }`.
- `POST /api/quiz` stores or updates quiz details in the Supabase `quiz_questions` table.

## Configure Supabase

1. In the Supabase project, open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql).
2. Copy the project URL and the server-side `service_role` key from the Supabase API settings.
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the backend environment. On Render, add them under the service's **Environment** settings. Do not put the service-role key in `content.js`, `background.js`, or any other extension file.

The table keeps question, labeled options, course, quiz date, quiz number, tags, and created/updated timestamps. Row Level Security is enabled without public policies; the backend uses its server-only key. The API continues matching by normalized question and matching options, with non-conflicting course/quiz number fields. Date is stored as metadata, not used for duplicate detection.

## Run locally

Requires Node.js 18 or newer. Copy `.env.example` to `.env`, set `AI_API_KEY`, and configure the provider values. Then run:

```sh
npm start
```

The server listens on port 3000 by default. `GET /health` returns a small health response.

## Provider switching

The default adapter (`providers/openai-compatible.js`) works with providers that share the OpenAI `/chat/completions` API format. For those providers, update `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY` in `.env`, then restart the server. Change `AI_SYSTEM_PROMPT` to adjust how the answer is written.

For an AI with a different API or response structure:

1. Copy `providers/custom-provider.example.js` to a new file, such as `providers/my-provider.js`.
2. Implement and export `async function generate({ apiKey, baseUrl, model, systemPrompt, userPrompt, quiz })` for that vendor. Parse its response and return the answer as a string (or an object with `answer`, `response`, `result`, `content`, or `text`).
3. Set `AI_PROVIDER_MODULE=./providers/my-provider.js` and that provider's settings in `.env`.
4. Restart/redeploy the backend.

The extension contract stays unchanged: it sends the same quiz JSON and the API returns `{ "answer": "..." }`. The frontend never sees or needs to know the provider's raw response structure. You only need backend code for a genuinely different provider protocol; ordinary provider/model switches need only backend configuration.

## Quiz storage

Quiz details are automatically posted to `POST /api/quiz` when an LMS quiz question page loads. The extension does not intercept or delay the LMS `#btnSave` (“Save Answer & Move to Next Question”) submit action. The **Copy quiz** button only copies to the clipboard. The selected answer itself is never sent or stored; saved fields are question, options, course, date, quiz number, and tags. Options are stored as objects with an explicit letter and text, for example `{ "letter": "A", "text": "First option" }`; requests can continue sending the existing string array format. Dates use a readable `DD Month YYYY` format, and `createdAt`/`updatedAt` use Pakistan time in 12-hour format with AM/PM. The backend matches by normalized question and matching options, with non-conflicting course/quiz number fields. When options are missing, it does not guess a duplicate. Date is stored and updated as metadata but is not part of duplicate detection, so a student repeating the same quiz another day updates the same record. Missing fields are filled from the new request while known saved values are preserved. If all quiz details already match, it skips the database write and returns `updated: false`; new or changed details return `updated: true`.

Quiz records are stored in Supabase PostgreSQL; the backend does not write quiz data to a local JSON file. The `/api/quiz` contract remains independent of the database implementation.

## Deploy at the extension's endpoint

Deploy this Node service as a Render Web Service with `backend` as its root directory, `npm install` as the build command, `npm start` as the start command, and `/health` as its health-check path. Add the Supabase and AI environment variables in Render. Render will provide a service URL; initially the API routes are `<render-service-url>/api/ai` and `<render-service-url>/api/quiz`. To retain `www.vutoolkit.com/api/...`, configure your domain host to proxy those paths to Render. Otherwise, use a dedicated API hostname and update the API URLs and `host_permissions` in the extension once.

The server currently allows CORS from any origin and does not require client authentication. Add authentication, rate limits, and an origin allowlist before exposing it publicly. Keep provider API keys in server environment variables only.

## Request and response

Request body:

```json
{
  "question": "Question text",
  "options": ["First option", "Second option"],
  "course": "mth100",
  "date": "2025-07-04",
  "quizNo": "4"
}
```

The backend stores those options as:

```json
[
  { "letter": "A", "text": "First option" },
  { "letter": "B", "text": "Second option" }
]
```

Successful response:

```json
{
  "answer": "The correct option is B. ..."
}
```

`POST /api/quiz` accepts the quiz detail fields and returns:

```json
{
  "id": "stable-record-hash",
  "saved": true,
  "updated": true
}
```
