import "dotenv/config";
import { Application } from "./app";
import { ServerAuthMiddleware } from "./http/middleware/ServerAuthMiddleware";
import { AuthRoute } from "./routes/auth/AuthRoute";
import { UserRoute } from "./routes/user/UserRoute";
import { MessageRoute } from "./routes/message/MessageRoute";
import { ChatRoute } from "./routes/message/ChatRoute";
import { ChannelRoute } from "./routes/channels/ChannelRoute";
import { ServerRoute } from "./routes/servers/ServerRoute";
import { TelegramClientService } from "./telegram/TelegramClientService";
import { TelegramSessionWatchdog } from "./telegram/TelegramSessionWatchdog";
import { DownloadWorkerService } from "./services/DownloadWorkerService";
import { TenantForwardingScheduler } from "./services/TenantForwardingScheduler";
import { MediaCleanupScheduler } from "./services/MediaCleanupScheduler";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function bootstrap(): Promise<void> {
	await TelegramClientService.restoreFromDatabase();

	const sessionWatchdog = new TelegramSessionWatchdog();
	sessionWatchdog.start();

	const downloadWorker = new DownloadWorkerService();
	await downloadWorker.start();

	const forwardingScheduler = new TenantForwardingScheduler();
	forwardingScheduler.start();

	const mediaCleanup = new MediaCleanupScheduler();
	mediaCleanup.start();

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
		]);

	await app.start(PORT);
}

bootstrap().catch((err: unknown) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
