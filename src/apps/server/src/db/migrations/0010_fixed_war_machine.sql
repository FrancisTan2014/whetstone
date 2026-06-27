CREATE TABLE "cases" (
	"communicative_function" text NOT NULL,
	"domain_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"order_index" integer NOT NULL,
	"situation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"case_id" text NOT NULL,
	"gloss" text,
	"id" text PRIMARY KEY NOT NULL,
	"order_index" integer NOT NULL,
	"text" text NOT NULL,
	"usage_note" text
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"weight" double precision NOT NULL,
	"order_index" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "chunk_id" text;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_domain_idx" ON "cases" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "chunks_case_idx" ON "chunks" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "recall_items" ADD CONSTRAINT "recall_items_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;