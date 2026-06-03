import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as dotenv from "dotenv";

dotenv.config();

async function runMigrations() {
	const client = new Client({
		connectionString: process.env.DATABASE_URL,
	});

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
