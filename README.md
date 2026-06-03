# Telegram REST API Server

A **Telegram REST API** server for user authentication and Telegram API operations. Built with **Fastify**, **TypeScript**, and **GramJS** (Telegram MTProto client). Exposes HTTP endpoints for sending login codes, resending codes, and signing in with a phone number and verification code.

## What is this project?

This project provides a REST API layer on top of the Telegram API. Instead of using the Telegram Bot API or running GramJS directly in your app, you can call this server over HTTP to:

- **Send a verification code** to a user's phone number (Telegram login flow)
- **Resend the verification code** using the same session
- **Sign in** with phone number, code hash, and the code received via SMS or Telegram

All endpoints use **GramJS** under the hood and follow the official [Telegram authentication](https://core.telegram.org/api/auth) flow. The server is designed to run in **Docker** and can be secured with an API key and `Accept: application/json` header checks.

## Tech stack

- **Runtime:** Node.js  
- **Framework:** Fastify  
- **Language:** TypeScript  
- **Telegram client:** GramJS (telegram)  
- **Deployment:** Docker Compose  

## Quick start

1. Clone the repository and add a `.env` file with `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `APPLICATION_API_KEY`, and `PORT`.
2. Run with Docker Compose:

   ```bash
   docker compose up --build
   ```

3. Send requests with header `api-key: <APPLICATION_API_KEY>` and `Accept: application/json`.

## Database Migrations (Drizzle)

All Drizzle commands run inside Docker. Use the **dev** compose file (`docker-compose.dev.yml`) for commands that need `drizzle-kit`.

### Generate a new migration

After modifying the schema in `src/database/schema.ts`, generate migration SQL files:

```bash
docker compose -f docker-compose.dev.yml run --rm api npx drizzle-kit generate
```

This creates `.sql` files and updates `drizzle/meta/_journal.json`.

### Apply migrations

Works with both dev and production images (uses `drizzle-orm`, not `drizzle-kit`):

```bash
docker compose run --rm api npm run migrate
```

### Push schema directly (development only)

Pushes the current schema to the database without generating migration files:

```bash
docker compose -f docker-compose.dev.yml run --rm api npx drizzle-kit push
```

### Open Drizzle Studio

```bash
docker compose -f docker-compose.dev.yml run --rm -p 4983:4983 api npx drizzle-kit studio
```

> **Note:** Commands that use `drizzle-kit` (`generate`, `push`, `studio`) require the dev image (`docker-compose.dev.yml`) because `drizzle-kit` is a dev dependency. The `migrate` command uses `drizzle-orm` (a production dependency) and works with either image.

## Documentation

Full API documentation, including **auth routes** (send code, resend code, sign in) with request/response bodies and examples, is in the **docs** folder:

- **[Documentation (Auth routes & API)](./docs/)**  
  - [Auth routes](./docs/auth-routes.md) — endpoints, request body, and response for Telegram user authentication.

## License

MIT
