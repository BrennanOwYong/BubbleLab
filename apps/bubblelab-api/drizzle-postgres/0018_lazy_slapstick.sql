CREATE TABLE "derived_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_credential_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"derived_credential_type" text NOT NULL,
	"provider" text NOT NULL,
	"is_derived" boolean DEFAULT true NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "derived_credentials_parent_credential_id_derived_credential_type_unique" UNIQUE("parent_credential_id","derived_credential_type")
);
--> statement-breakpoint
ALTER TABLE "derived_credentials" ADD CONSTRAINT "derived_credentials_parent_credential_id_user_credentials_id_fk" FOREIGN KEY ("parent_credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_credentials" ADD CONSTRAINT "derived_credentials_user_id_users_clerk_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;