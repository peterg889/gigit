CREATE TABLE "ai_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"actor_user_id" text,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"model" text,
	"prompt_version" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
