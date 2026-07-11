CREATE TABLE "recitation_chains" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_entry_id" text NOT NULL,
	"end_order_index" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recitation_whole_work" (
	"plan_entry_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stability" double precision NOT NULL,
	"difficulty" double precision NOT NULL,
	"elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"learning_steps" integer NOT NULL,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"state" text NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recitation_chains" ADD CONSTRAINT "recitation_chains_plan_entry_id_recitation_plans_entry_id_fk" FOREIGN KEY ("plan_entry_id") REFERENCES "public"."recitation_plans"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recitation_whole_work" ADD CONSTRAINT "recitation_whole_work_plan_entry_id_recitation_plans_entry_id_fk" FOREIGN KEY ("plan_entry_id") REFERENCES "public"."recitation_plans"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recitation_chains_plan_idx" ON "recitation_chains" USING btree ("plan_entry_id","status");