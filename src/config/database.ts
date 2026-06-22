import fs from "fs";
import type { ClientConfig } from "pg";

function parseBoolean(value: string | undefined): boolean {
	return ["true", "1", "yes", "on"].includes(
		(value ?? "").trim().toLowerCase(),
	);
}

/**
 * Builds the pg SSL option from env.
 * - DB_SSL=false        -> SSL disabled
 * - DB_SSL=true, no cert -> SSL enabled, certificate verification skipped
 * - DB_SSL=true + cert   -> SSL enabled, verified against the provided CA cert
 */
function buildSslConfig(): ClientConfig["ssl"] {
	if (!parseBoolean(process.env.DB_SSL)) {
		return false;
	}

	const certPath = process.env.DB_SSL_CERT?.trim();
	if (certPath && fs.existsSync(certPath)) {
		return {
			ca: fs.readFileSync(certPath, "utf-8"),
			rejectUnauthorized: true,
		};
	}

	// SSL is enabled but the CA certificate is optional.
	return { rejectUnauthorized: false };
}

/**
 * Resolves the Postgres connection config from discrete environment variables:
 * DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME, DB_SSL (and optional DB_SSL_CERT).
 */
export function getDatabaseConfig(): ClientConfig {
	return {
		host: process.env.DB_HOST,
		port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
		user: process.env.DB_USERNAME,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_NAME,
		ssl: buildSslConfig(),
	};
}
