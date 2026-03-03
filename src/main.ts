import { App, Editor, MarkdownView, Modal, Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab } from "./settings";
import { syncWithYandex } from "./yandex/sync";
import { syncWithYandexWebdav } from "./yandex/sync-webdav";
import { YandexDiskApiError } from "./yandex/api";
import { YandexWebdavError } from "./yandex/webdav";
import { GoogleDriveApi, GoogleDriveApiError } from "./google-drive/api";
import { syncWithGoogleDrive } from "./google-drive/sync";

export default class SyncronizerPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// Иконка синхронизации с Яндекс.Диском в левой панели
		this.addRibbonIcon("cloud", "Синхронизация с Яндекс.Диском", () => {
			this.runYandexSync();
		});
		this.addRibbonIcon("cloud-upload", "Синхронизация с Google Drive", () => {
			this.runGoogleDriveSync();
		});

		// Кнопка синхронизации в строке состояния внизу окна
		const statusBarItem = this.addStatusBarItem();
		statusBarItem.createEl("span", { cls: "syncronizer-status-bar clickable" }, (el) => {
			el.textContent = "☁ Синхронизация";
			el.title = "Синхронизировать с Яндекс.Диском / Google Drive (см. команды)";
			el.addEventListener("click", () => this.runYandexSync());
		});

		// Команда: синхронизация с Яндекс.Диском
		this.addCommand({
			id: "yandex-sync",
			name: "Синхронизировать с Яндекс.Диском",
			callback: () => this.runYandexSync(),
		});
		this.addCommand({
			id: "google-drive-sync",
			name: "Синхронизировать с Google Drive",
			callback: () => this.runGoogleDriveSync(),
		});

		// Остальные команды (образец)
		this.addCommand({
			id: "open-modal-simple",
			name: "Open modal (simple)",
			callback: () => {
				new SampleModal(this.app).open();
			},
		});
		this.addCommand({
			id: "replace-selected",
			name: "Replace selected content",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				editor.replaceSelection("Sample editor command");
			},
		});
		this.addCommand({
			id: "open-modal-complex",
			name: "Open modal (complex)",
			checkCallback: (checking: boolean) => {
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) {
						new SampleModal(this.app).open();
					}
					return true;
				}
				return false;
			},
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	async runYandexSync(): Promise<void> {
		const method = this.settings.yandexSyncMethod || "api";
		const folder = this.settings.yandexSyncFolder?.trim() || "Obsidian";
		const direction = this.settings.yandexSyncDirection;

		if (method === "api") {
			const token = this.settings.yandexAccessToken?.trim();
			if (!token) {
				new Notice("Укажите OAuth-токен Яндекс.Диска в настройках плагина.");
				return;
			}
			new Notice("Синхронизация с Яндекс.Диском (REST API)…");
			try {
				const result = await syncWithYandex(this.app, token, folder, direction);
				this.showSyncResult(result, () => {
					new Notice(
						"Токен недействителен или истёк. Откройте настройки плагина → получите новый токен (кнопка «Открыть страницу авторизации»).",
						8000
					);
				});
			} catch (e) {
				this.handleSyncError(e, "api");
			}
			return;
		}

		// WebDAV
		const url = this.settings.yandexWebdavUrl?.trim() || "https://webdav.yandex.ru";
		const login = this.settings.yandexWebdavLogin?.trim();
		const password = this.settings.yandexWebdavPassword ?? "";
		if (!login) {
			new Notice("Укажите логин и пароль WebDAV в настройках плагина.");
			return;
		}
		new Notice("Синхронизация с Яндекс.Диском (WebDAV)…");
		try {
			const result = await syncWithYandexWebdav(
				this.app,
				url,
				login,
				password,
				folder,
				direction
			);
			this.showSyncResult(result, () => {
				new Notice(
					"Неверный логин или пароль WebDAV. Проверьте настройки плагина.",
					8000
				);
			});
		} catch (e) {
			this.handleSyncError(e, "webdav");
		}
	}

	async runGoogleDriveSync(): Promise<void> {
		const clientId = this.settings.googleDriveClientId?.trim();
		const clientSecret = this.settings.googleDriveClientSecret?.trim();
		const accessToken = this.settings.googleDriveAccessToken?.trim();
		if (!clientId || !clientSecret || !accessToken) {
			new Notice(
				"Настройте Google Drive: Client ID, Client Secret и получите токены в настройках плагина."
			);
			return;
		}
		const folder = this.settings.googleDriveSyncFolder?.trim() || "Obsidian";
		const direction = this.settings.googleDriveSyncDirection;
		new Notice("Синхронизация с Google Drive…");
		try {
			const api = new GoogleDriveApi(
				{
					access_token: accessToken,
					refresh_token: this.settings.googleDriveRefreshToken || undefined,
					expiry_date: this.settings.googleDriveExpiryDate || undefined,
				},
				clientId,
				clientSecret
			);
			const result = await syncWithGoogleDrive(
				this.app,
				api,
				folder,
				direction
			);
			const updated = api.getTokens();
			this.settings.googleDriveAccessToken = updated.access_token;
			if (updated.refresh_token)
				this.settings.googleDriveRefreshToken = updated.refresh_token;
			if (updated.expiry_date)
				this.settings.googleDriveExpiryDate = updated.expiry_date;
			await this.saveSettings();
			this.showSyncResult(result, () => {
				new Notice(
					"Токен Google Drive недействителен. Получите новые токены в настройках плагина.",
					8000
				);
			});
		} catch (e) {
			this.handleGoogleDriveSyncError(e);
		}
	}

	private handleGoogleDriveSyncError(e: unknown): void {
		const message =
			e instanceof GoogleDriveApiError
				? e.message
				: e instanceof Error
					? e.message
					: String(e);
		new Notice("Ошибка синхронизации Google Drive: " + message);
		if (
			message.includes("401") ||
			message.includes("invalid_grant") ||
			message.includes("Token")
		) {
			new Notice(
				"Токен недействителен или истёк. Настройки плагина → Google Drive → «Получить токены».",
				8000
			);
		}
		console.error("Synchronizer Google Drive sync error:", e);
	}

	private showSyncResult(
		result: { uploaded: number; downloaded: number; errors: string[] },
		onAuthError: () => void
	): void {
		const msg = [
			`Выгружено: ${result.uploaded}`,
			`Загружено: ${result.downloaded}`,
		].join(", ");
		new Notice(result.errors.length ? `${msg}. Ошибки: ${result.errors.length}` : msg);
		if (result.errors.length > 0) {
			console.error("Synchronizer Yandex errors:", result.errors);
			if (
				result.errors.some((err) =>
					err.includes("401") || err.includes("403") || err.includes("Не авторизован")
				)
			) {
				onAuthError();
			}
		}
	}

	private handleSyncError(e: unknown, method: "api" | "webdav"): void {
		const message =
			e instanceof YandexDiskApiError || e instanceof YandexWebdavError
				? e.message
				: e instanceof Error
					? e.message
					: String(e);
		new Notice("Ошибка синхронизации: " + message);
		if (e instanceof YandexDiskApiError && e.status === 401) {
			new Notice(
				"Токен недействителен или истёк. Настройки плагина → «Открыть страницу авторизации» → вставьте новый токен.",
				8000
			);
		} else if (e instanceof YandexWebdavError && (e.status === 401 || e.status === 403)) {
			new Notice("Неверный логин или пароль WebDAV. Проверьте настройки плагина.", 8000);
		} else if (message.includes("401") || message.includes("Не авторизован")) {
			new Notice(
				method === "api"
					? "Токен недействителен или истёк. Получите новый токен в настройках плагина."
					: "Неверный логин или пароль WebDAV. Проверьте настройки плагина.",
				8000
			);
		}
		console.error("Synchronizer Yandex sync error:", e);
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
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
		let {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
