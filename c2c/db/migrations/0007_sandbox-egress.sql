ALTER TABLE "agent_definitions" ADD COLUMN "egress_extra_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_definitions" DROP COLUMN "auto_approve";--> statement-breakpoint
-- "ask" can never be answered in a one-shot pod; it only ever cost a timeout.
UPDATE "agent_definitions" SET "permissions" = (
  SELECT jsonb_object_agg(key, CASE WHEN value::text = '"ask"' THEN '"deny"'::jsonb ELSE value END)
  FROM jsonb_each("permissions")
) WHERE "permissions"::text LIKE '%"ask"%';
