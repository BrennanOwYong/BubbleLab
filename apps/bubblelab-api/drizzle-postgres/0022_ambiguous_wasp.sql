CREATE TABLE "user_defaults" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"source_flow_id" integer,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "user_defaults_user_id_key_pk" PRIMARY KEY("user_id","key")
);
