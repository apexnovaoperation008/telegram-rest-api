import { defineConfig } from "drizzle-kit";
import { getDatabaseConfig } from "./src/config/database";

const { host, port, user, password, database, ssl } = getDatabaseConfig();

export default defineConfig({
	schema: "./src/database/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		host: host!,
		port,
		user,
		password: password as string | undefined,
		database: database!,
		ssl: ssl as boolean | Record<string, unknown> | undefined,
	},
});
