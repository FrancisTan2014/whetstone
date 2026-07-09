-- Async Tap-and-Talk (#565): a queued voice capture is durable before STT runs. `processing_status`
-- walks `queued -> transcribing -> tidying -> ready | failed`; `failure_reason` records why the worker
-- gave up so a failed capture can be retried. Both are NULL for existing/synchronous captures, which
-- were ready on write and never entered the queue.
ALTER TABLE "timeline_entries" ADD COLUMN "processing_status" text;--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD COLUMN "failure_reason" text;