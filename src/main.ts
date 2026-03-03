import { App, Editor, MarkdownView, Modal, Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
	type SyncTarget,
} from "./settings";
import { syncWithYandex } from "./yandex/sync";
import { syncWithYandexWebdav } from "./yandex/sync-webdav";
import { GoogleDriveApi } from "./google-drive/api";
import { syncWithGoogleDrive } from "./google-drive/sync";

function generateId(): string {
	return "sync-" + Math.random().toString(36).slice(2, 11);
}

/** Создать целевой объект по умолчанию с возможностью .with(partial) для миграции */
function defaultTarget(
	method: "yandex" | "google-drive" | "webdav",
): SyncTarget & {
	with: (p: Partial<SyncTarget>) => SyncTarget;
} {
	const t: SyncTarget = {
		id: generateId(),
		method,
		enabled: true,
		folder: "Obsidian",
		direction: "both",
		yandexClientId: "",
		yandexAccessToken: "",
		webdavUrl: "",
		webdavLogin: "",
		webdavPassword: "",
		googleDriveClientId: "",
		googleDriveClientSecret: "",
		googleDriveAccessToken: "",
		googleDriveRefreshToken: "",
		googleDriveExpiryDate: 0,
	};
	return {
		...t,
		with(p: Partial<SyncTarget>) {
			return { ...t, ...p };
		},
	};
}

export default class SyncronizerPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// Одна иконка синхронизации в левой панели — запускает все включённые способы
		this.addRibbonIcon("folder-sync", "Синхронизировать", () => {
			this.runAllEnabledSyncs();
		});

		const statusBarItem = this.addStatusBarItem();
		statusBarItem.createEl(
			"span",
			{ cls: "syncronizer-status-bar clickable" },
			(el) => {
				el.textContent = "☁ Синхронизация";
				el.title = "Синхронизировать по всем включённым способам";
				el.addEventListener("click", () => this.runAllEnabledSyncs());
			},
		);

		this.addCommand({
			id: "sync-all",
			name: "Синхронизировать (все включённые способы)",
			callback: () => this.runAllEnabledSyncs(),
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	/** Запуск синхронизации по всем включённым способам */
	async runAllEnabledSyncs(): Promise<void> {
		const targets = this.settings.syncTargets.filter((t) => t.enabled);
		if (targets.length === 0) {
			new Notice(
				"Нет включённых способов синхронизации. Добавьте способ в настройках и включите его.",
			);
			return;
		}
		new Notice(`Синхронизация (${targets.length} types) `);
		let totalUploaded = 0;
		let totalDownloaded = 0;
		const allErrors: string[] = [];
		for (const target of targets) {
			try {
				const result = await this.runSyncForTarget(target);
				totalUploaded += result.uploaded;
				totalDownloaded += result.downloaded;
				if (result.errors.length > 0) {
					allErrors.push(...result.errors);
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`Ошибка (${target.method}): ${msg}`);
				allErrors.push(`${target.method}: ${msg}`);
			}
		}
		this.showSyncResult(
			{
				uploaded: totalUploaded,
				downloaded: totalDownloaded,
				errors: allErrors,
			},
			() => {
				new Notice(
					"Обнаружены ошибки доступа (401/403). Проверьте учётные данные в настройках.",
					8000,
				);
			},
		);
	}

	/** Синхронизация по одному способу */
	private async runSyncForTarget(
		target: SyncTarget,
	): Promise<{ uploaded: number; downloaded: number; errors: string[] }> {
		const folder = target.folder?.trim() || "Obsidian";
		const direction = target.direction;

		if (target.method === "yandex") {
			const token = target.yandexAccessToken?.trim();
			if (!token) {
				return {
					uploaded: 0,
					downloaded: 0,
					errors: ["Яндекс: нет токена"],
				};
			}
			return await syncWithYandex(this.app, token, folder, direction);
		}

		if (target.method === "webdav") {
			const url = target.webdavUrl?.trim();
			const login = target.webdavLogin?.trim();
			const password = target.webdavPassword ?? "";
			if (!url || !login) {
				return {
					uploaded: 0,
					downloaded: 0,
					errors: ["WebDAV: нет URL или логина"],
				};
			}
			return await syncWithYandexWebdav(
				this.app,
				url,
				login,
				password,
				folder,
				direction,
			);
		}

		// Google Drive
		const clientId = target.googleDriveClientId?.trim();
		const clientSecret = target.googleDriveClientSecret?.trim();
		const accessToken = target.googleDriveAccessToken?.trim();
		if (!clientId || !clientSecret || !accessToken) {
			return {
				uploaded: 0,
				downloaded: 0,
				errors: ["Google Drive: нет токенов"],
			};
		}
		const api = new GoogleDriveApi(
			{
				access_token: accessToken,
				refresh_token: target.googleDriveRefreshToken || undefined,
				expiry_date: target.googleDriveExpiryDate || undefined,
			},
			clientId,
			clientSecret,
		);
		const result = await syncWithGoogleDrive(
			this.app,
			api,
			folder,
			direction,
		);
		const updated = api.getTokens();
		target.googleDriveAccessToken = updated.access_token;
		if (updated.refresh_token)
			target.googleDriveRefreshToken = updated.refresh_token;
		if (updated.expiry_date)
			target.googleDriveExpiryDate = updated.expiry_date;
		await this.saveSettings();
		return result;
	}

	private showSyncResult(
		result: { uploaded: number; downloaded: number; errors: string[] },
		onAuthError: () => void,
	): void {
		const msg = [
			`Выгружено: ${result.uploaded}`,
			`Загружено: ${result.downloaded}`,
		].join(", ");
		new Notice(
			result.errors.length
				? `${msg}. Ошибки: ${result.errors.length}`
				: msg,
		);
		if (result.errors.length > 0) {
			console.error("Synchronizer errors:", result.errors);
			if (
				result.errors.some(
					(err) =>
						err.includes("401") ||
						err.includes("403") ||
						err.includes("Не авторизован"),
				)
			) {
				onAuthError();
			}
		}
	}

	onunload() {}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<MyPluginSettings> &
			Record<string, unknown>;
		// Миграция со старого формата (плоские ключи) в syncTargets
		if (!data?.syncTargets?.length && data) {
			const targets: SyncTarget[] = [];
			if (
				data.yandexAccessToken &&
				typeof data.yandexAccessToken === "string" &&
				data.yandexAccessToken.trim()
			) {
				targets.push(
					defaultTarget("yandex").with({
						yandexClientId: (data.yandexClientId as string) ?? "",
						yandexAccessToken:
							(data.yandexAccessToken as string) ?? "",
						folder: (data.yandexSyncFolder as string) || "Obsidian",
						direction:
							(data.yandexSyncDirection as
								| "upload"
								| "download"
								| "both") || "both",
					}),
				);
			}
			if (
				data.webdavUrl &&
				typeof data.webdavUrl === "string" &&
				data.webdavUrl.trim()
			) {
				targets.push(
					defaultTarget("webdav").with({
						webdavUrl: (data.webdavUrl as string) ?? "",
						webdavLogin: (data.webdavLogin as string) ?? "",
						webdavPassword: (data.webdavPassword as string) ?? "",
						folder: (data.webdavSyncFolder as string) || "Obsidian",
						direction:
							(data.webdavSyncDirection as
								| "upload"
								| "download"
								| "both") || "both",
					}),
				);
			}
			if (
				data.googleDriveAccessToken &&
				typeof data.googleDriveAccessToken === "string" &&
				data.googleDriveAccessToken.trim()
			) {
				targets.push(
					defaultTarget("google-drive").with({
						googleDriveClientId:
							(data.googleDriveClientId as string) ?? "",
						googleDriveClientSecret:
							(data.googleDriveClientSecret as string) ?? "",
						googleDriveAccessToken:
							(data.googleDriveAccessToken as string) ?? "",
						googleDriveRefreshToken:
							(data.googleDriveRefreshToken as string) ?? "",
						googleDriveExpiryDate:
							(data.googleDriveExpiryDate as number) ?? 0,
						folder:
							(data.googleDriveSyncFolder as string) ||
							"Obsidian",
						direction:
							(data.googleDriveSyncDirection as
								| "upload"
								| "download"
								| "both") || "both",
					}),
				);
			}
			if (targets.length > 0) {
				data.syncTargets = targets;
			}
		}
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data,
		) as MyPluginSettings;
		if (!Array.isArray(this.settings.syncTargets)) {
			this.settings.syncTargets = [];
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText("Woah!");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
