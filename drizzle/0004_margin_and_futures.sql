CREATE TABLE "leveraged_positions" (
	"scenario_id" uuid NOT NULL,
	"account" text NOT NULL,
	"instrument_id" integer NOT NULL,
	"side" text NOT NULL,
	"qty" double precision NOT NULL,
	"entry_price" double precision NOT NULL,
	"mark" double precision NOT NULL,
	"accrued" double precision NOT NULL,
	CONSTRAINT "leveraged_positions_scenario_id_account_instrument_id_pk" PRIMARY KEY("scenario_id","account","instrument_id")
);
--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN "account" text;--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "account" text DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "scenario_instruments" ADD COLUMN "base_fx" double precision;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "futures_tax_realized" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "futures_tax_paid" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "margin_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "force_close" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leveraged_positions" ADD CONSTRAINT "leveraged_positions_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;