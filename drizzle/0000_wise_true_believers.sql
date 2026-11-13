CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`seen` integer NOT NULL,
	`inventory` text NOT NULL,
	`mode` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`created` integer NOT NULL,
	`action` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`names` text NOT NULL,
	`options` text NOT NULL,
	`pages` integer NOT NULL,
	`amount` integer NOT NULL,
	`method` text NOT NULL,
	`payment` text NOT NULL,
	`status` text NOT NULL,
	`file` text NOT NULL,
	`printer` text,
	`claim` text,
	`error` text,
	`gateway` text,
	`payment_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_token_unique` ON `orders` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_gateway_unique` ON `orders` (`gateway`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_payment_id_unique` ON `orders` (`payment_id`);--> statement-breakpoint
CREATE TABLE `printers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`brand` text NOT NULL,
	`model` text NOT NULL,
	`capability` text NOT NULL,
	`connection` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `printers_name_unique` ON `printers` (`name`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
