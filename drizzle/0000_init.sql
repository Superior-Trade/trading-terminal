CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"summary" text,
	"summary_upto_message_id" text,
	"state_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan_json" text NOT NULL,
	"symbol" text,
	"timeframe" text,
	"origin" text DEFAULT 'ours' NOT NULL,
	"mode" text DEFAULT 'recurring' NOT NULL,
	"autostopped_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liq_levels" (
	"coin" text NOT NULL,
	"bin_start" double precision NOT NULL,
	"bin_end" double precision NOT NULL,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL,
	"value" double precision NOT NULL,
	"positions_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "liq_levels_coin_bin_start_pk" PRIMARY KEY("coin","bin_start")
);
--> statement-breakpoint
CREATE TABLE "market_positioning" (
	"coin" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"crowd_long" integer DEFAULT 0 NOT NULL,
	"crowd_short" integer DEFAULT 0 NOT NULL,
	"smart_long" integer DEFAULT 0 NOT NULL,
	"smart_short" integer DEFAULT 0 NOT NULL,
	"whale_long" integer DEFAULT 0 NOT NULL,
	"whale_short" integer DEFAULT 0 NOT NULL,
	"retail_long" integer DEFAULT 0 NOT NULL,
	"retail_short" integer DEFAULT 0 NOT NULL,
	"rekt_long" integer DEFAULT 0 NOT NULL,
	"rekt_short" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"parts_json" text NOT NULL,
	"metadata_json" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "of_bins" (
	"coin" text NOT NULL,
	"bucket" bigint NOT NULL,
	"bin" double precision NOT NULL,
	"buy" double precision DEFAULT 0 NOT NULL,
	"sell" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "of_bins_coin_bucket_bin_pk" PRIMARY KEY("coin","bucket","bin")
);
--> statement-breakpoint
CREATE TABLE "of_meta" (
	"coin" text PRIMARY KEY NOT NULL,
	"bin_size" double precision NOT NULL,
	"started_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "strategy_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"symbol" text,
	"model" text,
	"plan_json" text NOT NULL,
	"artifact_json" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counter" (
	"user_id" text NOT NULL,
	"bucket" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "usage_counter_user_id_bucket_pk" PRIMARY KEY("user_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"privy_did" text PRIMARY KEY NOT NULL,
	"wallet_address" text,
	"st_key_encrypted" text,
	"lang" text DEFAULT 'en',
	"theme" text DEFAULT 'dark',
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_deployments_user" ON "deployments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_strategy_log_user" ON "strategy_log" USING btree ("user_id","created_at");