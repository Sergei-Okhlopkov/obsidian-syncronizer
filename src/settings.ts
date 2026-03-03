import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import SyncronizerPlugin from "./main";
import {
	getGoogleAuthUrl,
	exchangeCodeForTokens,
	GOOGLE_REDIRECT_URI,
	type GoogleDriveTokens,
} from "./google-drive/api";

export interface MyPluginSettings {
	mySetting: string;
	// Яндекс.Диск (только REST API)
	yandexClientId: string;
	yandexAccessToken: string;
	yandexSyncFolder: string;
	yandexSyncDirection: "upload" | "download" | "both";
	// WebDAV (любое облако: Nextcloud, ownCloud, Яндекс и т.д.)
	webdavUrl: string;
	webdavLogin: string;
	webdavPassword: string;
	webdavSyncFolder: string;
	webdavSyncDirection: "upload" | "download" | "both";
	// Google Drive
	googleDriveClientId: string;
	googleDriveClientSecret: string;
	googleDriveAccessToken: string;
	googleDriveRefreshToken: string;
	googleDriveExpiryDate: number;
	googleDriveSyncFolder: string;
	googleDriveSyncDirection: "upload" | "download" | "both";
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	yandexClientId: "",
	yandexAccessToken: "",
	yandexSyncFolder: "Obsidian",
	yandexSyncDirection: "both",
	webdavUrl: "",
	webdavLogin: "",
	webdavPassword: "",
	webdavSyncFolder: "Obsidian",
	webdavSyncDirection: "both",
	googleDriveClientId: "",
	googleDriveClientSecret: "",
	googleDriveAccessToken: "",
	googleDriveRefreshToken: "",
	googleDriveExpiryDate: 0,
	googleDriveSyncFolder: "Obsidian",
	googleDriveSyncDirection: "both",
};

const YANDEX_AUTH_URL = "https://oauth.yandex.ru/authorize?response_type=token&client_id=";

const YANDEX_INSTRUCTION =
	"1) Зайдите на oauth.yandex.ru и создайте приложение. 2) Укажите Redirect URI: https://oauth.yandex.ru/verification_code. 3) Вставьте Client ID ниже и нажмите «Открыть страницу авторизации». 4) Войдите в аккаунт и скопируйте токен со страницы в поле «Токен». Для синхронизации Яндекс.Диска по WebDAV используйте раздел «WebDAV (любое облако)» с URL https://webdav.yandex.ru.";

export class SampleSettingTab extends PluginSettingTab {
	plugin: SyncronizerPlugin;

	constructor(app: App, plugin: SyncronizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// ——— Яндекс.Диск (REST API) ———
		containerEl.createEl("h2", { text: "Яндекс.Диск" });
		const yandexInstr = containerEl.createDiv({ cls: "synchronizer-instruction" });
		yandexInstr.createEl("strong", { text: "Как подключить: " });
		yandexInstr.appendText(YANDEX_INSTRUCTION);
		const apiSection = containerEl.createDiv({ cls: "synchronizer-method-section" });
		new Setting(apiSection)
			.setName("Client ID")
			.setDesc("ID приложения из OAuth (oauth.yandex.ru)")
			.addText((text) =>
				text
					.setPlaceholder("Client ID")
					.setValue(this.plugin.settings.yandexClientId)
					.onChange(async (value) => {
						this.plugin.settings.yandexClientId = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(apiSection)
			.setName("OAuth-токен")
			.setDesc("Токен со страницы авторизации")
			.addText((text) => {
				text
					.setPlaceholder("Вставьте токен")
					.setValue(this.plugin.settings.yandexAccessToken)
					.onChange(async (value) => {
						this.plugin.settings.yandexAccessToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});
		new Setting(apiSection)
			.setName("Получить токен")
			.setDesc("Открыть страницу авторизации в браузере")
			.addButton((btn) =>
				btn.setButtonText("Открыть страницу авторизации").onClick(() => {
					const clientId = this.plugin.settings.yandexClientId?.trim();
					if (!clientId) return;
					window.open(YANDEX_AUTH_URL + encodeURIComponent(clientId), "_blank");
				})
			);

		// Папка и направление (Яндекс)
		new Setting(containerEl)
			.setName("Папка на Яндекс.Диске")
			.setDesc("Путь к папке для синхронизации (например: Obsidian или Backup/Vault). Для WebDAV с Яндексом используйте раздел «WebDAV (любое облако)».")
			.addText((text) =>
				text
					.setPlaceholder("Obsidian")
					.setValue(this.plugin.settings.yandexSyncFolder)
					.onChange(async (value) => {
						this.plugin.settings.yandexSyncFolder = (value || "Obsidian").replace(/^\/+/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Направление синхронизации")
			.setDesc("Что синхронизировать с Яндекс.Диском")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("both", "Двусторонняя (загрузка и выгрузка)")
					.addOption("upload", "Только выгрузка (хранилище → Диск)")
					.addOption("download", "Только загрузка (Диск → хранилище)")
					.setValue(this.plugin.settings.yandexSyncDirection)
					.onChange(async (value: "upload" | "download" | "both") => {
						this.plugin.settings.yandexSyncDirection = value;
						await this.plugin.saveSettings();
					})
			);

		// ——— WebDAV (любое облако) ———
		containerEl.createEl("h2", { text: "WebDAV (любое облако)" });
		const wdInstr = containerEl.createDiv({ cls: "synchronizer-instruction" });
		wdInstr.createEl("strong", { text: "Подходит для: " });
		wdInstr.appendText(
			"Nextcloud, ownCloud, Яндекс.Диск, Synology, InfiniCLOUD, Box, Dropbox (через WebDAV) и других сервисов с поддержкой WebDAV. Укажите URL сервера (например https://nextcloud.example.com/remote.php/dav/files/USERNAME/), логин и пароль."
		);
		const wdSection = containerEl.createDiv({ cls: "synchronizer-method-section" });
		new Setting(wdSection)
			.setName("WebDAV URL")
			.setDesc("Адрес WebDAV (корень хранилища или папки)")
			.addText((text) =>
				text
					.setPlaceholder("https://webdav.example.com/ или https://webdav.yandex.ru")
					.setValue(this.plugin.settings.webdavUrl)
					.onChange(async (value) => {
						this.plugin.settings.webdavUrl = (value || "").trim();
						await this.plugin.saveSettings();
					})
			);
		new Setting(wdSection)
			.setName("Логин")
			.setDesc("Логин WebDAV")
			.addText((text) =>
				text
					.setPlaceholder("Логин")
					.setValue(this.plugin.settings.webdavLogin)
					.onChange(async (value) => {
						this.plugin.settings.webdavLogin = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(wdSection)
			.setName("Пароль")
			.setDesc("Пароль WebDAV")
			.addText((text) => {
				text
					.setPlaceholder("Пароль")
					.setValue(this.plugin.settings.webdavPassword)
					.onChange(async (value) => {
						this.plugin.settings.webdavPassword = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});
		new Setting(containerEl)
			.setName("Папка на WebDAV")
			.setDesc(
				"Путь к папке для синхронизации относительно URL (например: Obsidian или Backup/Vault). Для Nextcloud — подпапка в вашем пространстве файлов."
			)
			.addText((text) =>
				text
					.setPlaceholder("Obsidian")
					.setValue(this.plugin.settings.webdavSyncFolder)
					.onChange(async (value) => {
						this.plugin.settings.webdavSyncFolder = (value || "Obsidian").replace(
							/^\/+/,
							""
						);
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Направление синхронизации (WebDAV)")
			.setDesc("Что синхронизировать по WebDAV")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("both", "Двусторонняя (загрузка и выгрузка)")
					.addOption("upload", "Только выгрузка (хранилище → WebDAV)")
					.addOption("download", "Только загрузка (WebDAV → хранилище)")
					.setValue(this.plugin.settings.webdavSyncDirection)
					.onChange(async (value: "upload" | "download" | "both") => {
						this.plugin.settings.webdavSyncDirection = value;
						await this.plugin.saveSettings();
					})
			);

		// ——— Google Drive ———
		containerEl.createEl("h2", { text: "Google Drive" });
		const gdInstr = containerEl.createDiv({ cls: "synchronizer-instruction" });
		gdInstr.createEl("strong", { text: "Как подключить: " });
		gdInstr.appendText(
			`1) В Google Cloud Console создайте проект и включите Google Drive API. 2) Создайте учётные данные OAuth 2.0: тип «Веб-приложение» (Web application). 3) В разделе «Authorized redirect URIs» добавьте ровно такой URI: ${GOOGLE_REDIRECT_URI} (скопируйте без изменений). 4) Укажите Client ID и Client Secret ниже. 5) Нажмите «Открыть страницу авторизации», войдите в Google; после перенаправления на страницу с ошибкой (ничего не открыто на порту) скопируйте из адресной строки параметр code (часть после code= и до &) или весь URL. 6) Вставьте в поле ниже и нажмите «Получить токены».`
		);
		const gdSection = containerEl.createDiv({ cls: "synchronizer-method-section" });
		new Setting(gdSection)
			.setName("Client ID")
			.setDesc("Идентификатор клиента OAuth 2.0")
			.addText((text) =>
				text
					.setPlaceholder("Client ID")
					.setValue(this.plugin.settings.googleDriveClientId)
					.onChange(async (value) => {
						this.plugin.settings.googleDriveClientId = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(gdSection)
			.setName("Client Secret")
			.setDesc("Секрет клиента OAuth 2.0")
			.addText((text) => {
				text
					.setPlaceholder("Client Secret")
					.setValue(this.plugin.settings.googleDriveClientSecret)
					.onChange(async (value) => {
						this.plugin.settings.googleDriveClientSecret = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});
		new Setting(gdSection)
			.setName("Авторизация")
			.setDesc("Открыть страницу входа в Google и получить код")
			.addButton((btn) =>
				btn.setButtonText("Открыть страницу авторизации").onClick(() => {
					const id = this.plugin.settings.googleDriveClientId?.trim();
					if (!id) {
						new Notice("Укажите Client ID.");
						return;
					}
					window.open(getGoogleAuthUrl(id), "_blank");
				})
			);
		let authCode = "";
		const extractCode = (value: string): string => {
			const v = value.trim();
			const match = v.match(/[?&]code=([^&]+)/);
			return match ? decodeURIComponent(match[1] ?? "") : v;
		};
		new Setting(gdSection)
			.setName("Код авторизации")
			.setDesc(
				`Вставьте параметр code из URL после перенаправления на ${GOOGLE_REDIRECT_URI} (или весь URL)`
			)
			.addText((text) =>
				text.setPlaceholder(`code=... или ${GOOGLE_REDIRECT_URI}/?code=...`).onChange((value) => {
					authCode = extractCode(value);
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Получить токены").onClick(async () => {
					const id = this.plugin.settings.googleDriveClientId?.trim();
					const secret = this.plugin.settings.googleDriveClientSecret?.trim();
					const code = authCode;
					if (!id || !secret) {
						new Notice("Укажите Client ID и Client Secret.");
						return;
					}
					if (!code) {
						new Notice("Вставьте код авторизации.");
						return;
					}
					try {
						const tokens: GoogleDriveTokens = await exchangeCodeForTokens(
							id,
							secret,
							code
						);
						this.plugin.settings.googleDriveAccessToken = tokens.access_token;
						this.plugin.settings.googleDriveRefreshToken =
							tokens.refresh_token ?? this.plugin.settings.googleDriveRefreshToken;
						this.plugin.settings.googleDriveExpiryDate =
							tokens.expiry_date ?? 0;
						await this.plugin.saveSettings();
						new Notice("Токены Google Drive сохранены.");
						this.display();
					} catch (e) {
						new Notice(
							"Ошибка получения токенов: " +
								(e instanceof Error ? e.message : String(e))
						);
					}
				})
			);
		new Setting(containerEl)
			.setName("Папка на Google Drive")
			.setDesc(
				"Имя или путь к папке для синхронизации (например: Obsidian или Backup/Vault)"
			)
			.addText((text) =>
				text
					.setPlaceholder("Obsidian")
					.setValue(this.plugin.settings.googleDriveSyncFolder)
					.onChange(async (value) => {
						this.plugin.settings.googleDriveSyncFolder = (
							value || "Obsidian"
						).replace(/^\/+/, "");
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Направление синхронизации (Google Drive)")
			.setDesc("Что синхронизировать с Google Drive")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("both", "Двусторонняя (загрузка и выгрузка)")
					.addOption("upload", "Только выгрузка (хранилище → Drive)")
					.addOption("download", "Только загрузка (Drive → хранилище)")
					.setValue(this.plugin.settings.googleDriveSyncDirection)
					.onChange(async (value: "upload" | "download" | "both") => {
						this.plugin.settings.googleDriveSyncDirection = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
