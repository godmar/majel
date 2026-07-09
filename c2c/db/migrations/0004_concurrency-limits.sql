ALTER TABLE "tasks" ADD COLUMN "provider_id" integer;--> statement-breakpoint
ALTER TABLE "user_provider_keys" ADD COLUMN "concurrency_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "tasks" SET "provider_id" = p."id"
FROM "agent_definitions" a, "providers" p
WHERE "tasks"."agent_definition_id" = a."id"
  AND p."name" = split_part(coalesce("tasks"."model_override", a."model"), '/', 1)
  AND "tasks"."provider_id" IS NULL;
