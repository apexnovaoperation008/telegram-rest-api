import "dotenv/config";
import { Application } from "./app";
import { ServerAuthMiddleware } from "./http/middleware/ServerAuthMiddleware";
import { AuthRoute } from "./routes/auth/AuthRoute";
import { UserRoute } from "./routes/user/UserRoute";
import { MessageRoute } from "./routes/message/MessageRoute";
import { ChatRoute } from "./routes/message/ChatRoute";
import { ChannelRoute } from "./routes/channels/ChannelRoute";
import { ContactRoute } from "./routes/contacts/ContactRoute";
import { ServerRoute } from "./routes/servers/ServerRoute";
import { TelegramClientService } from "./telegram/TelegramClientService";
import { TelegramSessionWatchdog } from "./telegram/TelegramSessionWatchdog";
import { TenantForwardingScheduler } from "./services/TenantForwardingScheduler";
import { S3UploadService } from "./services/S3UploadService";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function bootstrap(): Promise<void> {
	if (!S3UploadService.isConfigured()) {
		throw new Error(
			"S3 storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.",
		);
	}

	await TelegramClientService.restoreFromDatabase();

	const sessionWatchdog = new TelegramSessionWatchdog();
	sessionWatchdog.start();

	const forwardingScheduler = new TenantForwardingScheduler();
	forwardingScheduler.start();

	const app = new Application();
	app
		.registerPublicRoutes([new ServerRoute()])
		.registerMiddleware(new ServerAuthMiddleware())
		.registerRoutes([
			new AuthRoute(),
			new UserRoute(),
			new MessageRoute(),
			new ChatRoute(),
			new ChannelRoute(),
			new ContactRoute(),
		]);

	await app.start(PORT);
}

bootstrap().catch((err: unknown) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
