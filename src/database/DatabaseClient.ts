import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseClientInterface } from "./interface/DatabaseClientInterface";
import { getDatabaseConfig } from "../config/database";

/**
 * Single shared Postgres connection pool for the whole process.
 *
 * Previously every {@link execute} call opened a brand-new `pg.Client`
 * (full TCP + auth handshake) and closed it again. Under load — e.g. 100
 * live sessions all persisting incoming messages while the forwarding
 * scheduler fans out across every session each second — this exhausted
 * Postgres `max_connections` and serialized the whole message pipeline,
 * causing multi-minute delivery delays.
 *
 * A bounded pool reuses a fixed number of long-lived connections, so the
 * handshake cost is paid once and concurrent demand is naturally queued
 * against `DB_POOL_MAX` connections instead of overwhelming the database.
 */
export class DatabaseClient implements DatabaseClientInterface {
	private static instance: DatabaseClient;

	private readonly pool: Pool;
	private readonly db: NodePgDatabase;

	private constructor() {
		const poolMax = Math.max(
			1,
			parseInt(process.env.DB_POOL_MAX ?? "20", 10),
		);
		const idleTimeoutMs = Math.max(
			0,
			parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? "30000", 10),
		);
		const connectionTimeoutMs = Math.max(
			0,
			parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? "10000", 10),
		);

		this.pool = new Pool({
			...getDatabaseConfig(),
			max: poolMax,
			idleTimeoutMillis: idleTimeoutMs,
			connectionTimeoutMillis: connectionTimeoutMs,
		});

		// A pool emits 'error' for idle clients that fail in the background.
		// Without a listener this would crash the process.
		this.pool.on("error", (err) => {
			console.error("[DatabaseClient] Idle pool client error:", err);
		});

		this.db = drizzle(this.pool);
	}

	static getInstance(): DatabaseClient {
		if (!DatabaseClient.instance) {
			DatabaseClient.instance = new DatabaseClient();
		}
		return DatabaseClient.instance;
	}

	/**
	 * Runs an operation against the shared pool. Each query transparently
	 * checks out a connection from the pool and returns it when done;
	 * transactions hold a single dedicated connection for their duration.
	 */
	async execute<T>(
		operation: (db: NodePgDatabase) => Promise<T>,
	): Promise<T> {
		return operation(this.db);
	}

	/** Closes the pool. Intended for graceful shutdown / tests. */
	async close(): Promise<void> {
		await this.pool.end();
	}
}
