CREATE TABLE IF NOT EXISTS "paper_account" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state_json" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "paper_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"coin" text,
	"message" text NOT NULL,
	"detail_json" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_paper_events_user" ON "paper_events" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_equity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "paper_equity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"equity" double precision NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_paper_equity_user" ON "paper_equity" USING btree ("user_id","created_at");
