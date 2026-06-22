import { Client } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseClientInterface } from "./interface/DatabaseClientInterface";
import { getDatabaseConfig } from "../config/database";

export class DatabaseClient implements DatabaseClientInterface {
	private static instance: DatabaseClient;

	private constructor() {}

	static getInstance(): DatabaseClient {
		if (!DatabaseClient.instance) {
			DatabaseClient.instance = new DatabaseClient();
		}
		return DatabaseClient.instance;
	}

	async execute<T>(
		operation: (db: NodePgDatabase) => Promise<T>,
	): Promise<T> {
		const client = new Client(getDatabaseConfig());
		await client.connect();
		try {
			const db = drizzle(client);
			return await operation(db);
		} finally {
			await client.end();
		}
	}
}
