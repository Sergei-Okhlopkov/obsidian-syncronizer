import { App, PluginSettingTab, Setting } from "obsidian";
import SyncronizerPlugin from "./main";

export type YandexSyncMethod = "api" | "webdav";

export interface MyPluginSettings {
	mySetting: string;
	// Способ синхронизации с Яндекс.Диском
	yandexSyncMethod: YandexSyncMethod;
	// REST API
	yandexClientId: string;
	yandexAccessToken: string;
	// WebDAV
	yandexWebdavUrl: string;
	yandexWebdavLogin: string;
	yandexWebdavPassword: string;
	// Общее
	yandexSyncFolder: string;
	yandexSyncDirection: "upload" | "download" | "both";
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	yandexSyncMethod: "api",
	yandexClientId: "",
	yandexAccessToken: "",
	yandexWebdavUrl: "https://webdav.yandex.ru",
	yandexWebdavLogin: "",
	yandexWebdavPassword: "",
	yandexSyncFolder: "Obsidian",
	yandexSyncDirection: "both",
};

const YANDEX_AUTH_URL = "https://oauth.yandex.ru/authorize?response_type=token&client_id=";

const INSTRUCTIONS: Record<YandexSyncMethod, string> = {
	api: "1) Зайдите на oauth.yandex.ru и создайте приложение. 2) Укажите Redirect URI: https://oauth.yandex.ru/verification_code. 3) Вставьте Client ID ниже и нажмите «Открыть страницу авторизации». 4) Войдите в аккаунт и скопируйте токен со страницы в поле «Токен».",
	webdav: "1) Используйте логин и пароль от аккаунта Яндекса (или пароль приложения из настроек безопасности). 2) URL по умолчанию: https://webdav.yandex.ru. 3) Укажите папку на Диске, с которой будет синхронизироваться хранилище.",
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: SyncronizerPlugin;

	constructor(app: App, plugin: SyncronizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Выбор способа синхронизации
		new Setting(containerEl)
			.setName("Способ синхронизации с Яндекс.Диском")
			.setDesc("Через REST API (OAuth-токен) или WebDAV (логин и пароль)")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("api", "Яндекс.Диск — REST API")
					.addOption("webdav", "Яндекс.Диск — WebDAV")
					.setValue(this.plugin.settings.yandexSyncMethod)
					.onChange(async (value: YandexSyncMethod) => {
						this.plugin.settings.yandexSyncMethod = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Инструкция
		const method = this.plugin.settings.yandexSyncMethod || "api";
		const instrEl = containerEl.createDiv({ cls: "synchronizer-instruction" });
		instrEl.createEl("strong", { text: "Как подключить: " });
		instrEl.appendText(INSTRUCTIONS[method]);

		const apiSection = containerEl.createDiv({ cls: "synchronizer-method-section" });
		if (method === "api") {
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
		} else {
			new Setting(apiSection)
				.setName("WebDAV URL")
				.setDesc("Адрес WebDAV (обычно https://webdav.yandex.ru)")
				.addText((text) =>
					text
						.setPlaceholder("https://webdav.yandex.ru")
						.setValue(this.plugin.settings.yandexWebdavUrl)
						.onChange(async (value) => {
							this.plugin.settings.yandexWebdavUrl = (value || "").trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(apiSection)
				.setName("Логин")
				.setDesc("Логин Яндекса (email или телефон)")
				.addText((text) =>
					text
						.setPlaceholder("Логин")
						.setValue(this.plugin.settings.yandexWebdavLogin)
						.onChange(async (value) => {
							this.plugin.settings.yandexWebdavLogin = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(apiSection)
				.setName("Пароль")
				.setDesc("Пароль от аккаунта или пароль приложения")
				.addText((text) => {
					text
						.setPlaceholder("Пароль")
						.setValue(this.plugin.settings.yandexWebdavPassword)
						.onChange(async (value) => {
							this.plugin.settings.yandexWebdavPassword = value;
							await this.plugin.saveSettings();
						});
					text.inputEl.type = "password";
				});
		}

		// Общие настройки: папка и направление
		new Setting(containerEl)
			.setName("Папка на Яндекс.Диске")
			.setDesc("Путь к папке для синхронизации (например: Obsidian или Backup/Vault)")
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
	}
}
