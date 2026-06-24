-- Normalize existing free-text work_meta.language values into the v0 set
-- (zh-CN / zh-TW / en), mirroring domain normalizeWorkLanguage.
UPDATE "work_meta" SET "language" = 'en' WHERE lower("language") LIKE 'en%';--> statement-breakpoint
UPDATE "work_meta" SET "language" = 'zh-TW' WHERE lower("language") IN ('zh-tw', 'zh-hant', 'zh-hk', 'zh-mo');--> statement-breakpoint
UPDATE "work_meta" SET "language" = 'zh-CN' WHERE lower("language") IN ('zh', 'zh-cn', 'zh-hans', 'zh-sg');--> statement-breakpoint
UPDATE "work_meta" SET "language" = 'en' WHERE "language" NOT IN ('zh-CN', 'zh-TW', 'en');
