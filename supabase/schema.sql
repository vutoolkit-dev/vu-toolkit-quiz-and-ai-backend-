-- Run this once in Supabase Dashboard > SQL Editor.
-- The extension must never receive the service-role key. Only the backend uses it.

create table if not exists public.quiz_questions (
  id text primary key,
  question text not null,
  question_key text not null,
  options jsonb not null default '[]'::jsonb,
  course text,
  date text,
  quiz_no text,
  tags jsonb not null default '[]'::jsonb,
  created_at text not null,
  updated_at text not null
);

create index if not exists quiz_questions_question_key_idx
  on public.quiz_questions (question_key);

alter table public.quiz_questions enable row level security;

-- No anon/authenticated policies are created. The backend accesses this table
-- using its server-only Supabase service-role key.
