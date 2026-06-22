import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as dotenv from "dotenv";
import { getDatabaseConfig } from "./config/database";

dotenv.config();

async function runMigrations() {
	const client = new Client(getDatabaseConfig());

	await client.connect();

	try {
		const db = drizzle(client);
		await migrate(db, { migrationsFolder: "./drizzle" });
		console.log("Migrations completed successfully.");
	} finally {
		await client.end();
	}
}

runMigrations().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
