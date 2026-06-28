CREATE TABLE "session_exchanges" (
	"case_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"order_index" integer NOT NULL,
	"repair_json" jsonb,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_exchanges" ADD CONSTRAINT "session_exchanges_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_exchanges_user_case_idx" ON "session_exchanges" USING btree ("user_id","case_id","order_index");