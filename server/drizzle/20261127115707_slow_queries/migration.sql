CREATE TABLE `slow_queries` (
	`id` integer PRIMARY KEY,
	`at` integer NOT NULL,
	`route` text NOT NULL,
	`query` text NOT NULL,
	`sql` text NOT NULL,
	`params` text NOT NULL,
	`ms` integer NOT NULL,
	`rows` integer NOT NULL
);
