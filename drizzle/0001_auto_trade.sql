CREATE TABLE IF NOT EXISTS "auto_trade_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"settings_json" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_trade_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auto_trade_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"symbol" text,
	"deployment_id" text,
	"message" text NOT NULL,
	"detail_json" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auto_trade_log_user" ON "auto_trade_log" USING btree ("user_id","created_at");
