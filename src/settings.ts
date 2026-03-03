import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import SyncronizerPlugin from "./main";
import {
	getGoogleAuthUrl,
	exchangeCodeForTokens,
	GOOGLE_REDIRECT_URI,
	type GoogleDriveTokens,
} from "./google-drive/api";

export type SyncMethod = "yandex" | "google-drive" | "webdav";
export type SyncDirection = "upload" | "download" | "both";

export interface SyncTarget {
	id: string;
	method: SyncMethod;
	enabled: boolean;
	folder: string;
	direction: SyncDirection;
	// Яндекс.Диск (REST API)
	yandexClientId: string;
	yandexAccessToken: string;
	// WebDAV
	webdavUrl: string;
	webdavLogin: string;
	webdavPassword: string;
	// Google Drive
	googleDriveClientId: string;
	googleDriveClientSecret: string;
	googleDriveAccessToken: string;
	googleDriveRefreshToken: string;
	googleDriveExpiryDate: number;
}

export interface MyPluginSettings {
	syncTargets: SyncTarget[];
}

const DEFAULT_TARGET = (id: string, method: SyncMethod): SyncTarget => ({
	id,
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
});

export const DEFAULT_SETTINGS: MyPluginSettings = {
	syncTargets: [],
};

const YANDEX_AUTH_URL =
	"https://oauth.yandex.ru/authorize?response_type=token&client_id=";

const METHOD_LABELS: Record<SyncMethod, string> = {
	yandex: "Яндекс.Диск",
	"google-drive": "Google Drive",
	webdav: "WebDAV",
};

const SYNC_METHODS: SyncMethod[] = ["yandex", "google-drive", "webdav"];

/** Доступные методы: те, что ещё не выбраны в других плашках (кроме текущей) */
function availableMethods(
	syncTargets: SyncTarget[],
	currentId: string,
): SyncMethod[] {
	const used = new Set(
		syncTargets.filter((t) => t.id !== currentId).map((t) => t.method),
	);
	return SYNC_METHODS.filter((m) => !used.has(m));
}

function generateId(): string {
	return "sync-" + Math.random().toString(36).slice(2, 11);
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: SyncronizerPlugin;

	constructor(app: App, plugin: SyncronizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const targets = this.plugin.settings.syncTargets;
		const usedMethods = new Set(targets.map((t) => t.method));
		const canAdd = targets.length < SYNC_METHODS.length;

		containerEl.createEl("h2", { text: "Способы синхронизации" });
		containerEl.createEl("p", {
			text: "Добавьте один или несколько способов. При нажатии на иконку синхронизации в боковой панели выполняются все включённые.",
		});

		targets.forEach((target, index) => {
			this.renderTargetCard(containerEl, target, index);
		});

		// Кнопка +
		const addRow = containerEl.createDiv({ cls: "synchronizer-add-row" });
		new Setting(addRow)
			.setName("")
			.setDesc("")
			.addButton((btn) => {
				btn.setButtonText("+ Добавить способ")
					.setCta()
					.onClick(async () => {
						const available = availableMethods(targets, "");
						const method = available[0] ?? "yandex";
						this.plugin.settings.syncTargets.push(
							DEFAULT_TARGET(generateId(), method),
						);
						await this.plugin.saveSettings();
						this.display();
					});
			});
		if (!canAdd) {
			const btn = addRow.querySelector("button");
			if (btn) {
				btn.setAttribute("disabled", "true");
				btn.parentElement?.setAttribute(
					"title",
					"Добавлены все три способа. Удалите плашку, чтобы освободить способ для новой.",
				);
			}
		}
	}

	private renderTargetCard(
		containerEl: HTMLElement,
		target: SyncTarget,
		index: number,
	): void {
		const card = containerEl.createDiv({ cls: "synchronizer-target-card" });
		const header = card.createDiv({ cls: "synchronizer-target-header" });
		const body = card.createDiv({ cls: "synchronizer-target-body" });

		// Выбор способа (только не занятые в других плашках)
		const available = availableMethods(
			this.plugin.settings.syncTargets,
			target.id,
		);
		const methodOptions: Record<string, string> = {};
		available.forEach((m) => {
			methodOptions[m] = METHOD_LABELS[m];
		});
		// Если текущий метод не в available (уже занят другим — не должно быть при корректных данных), всё равно показываем его
		if (!methodOptions[target.method]) {
			methodOptions[target.method] = METHOD_LABELS[target.method];
		}

		const headerRow1 = header.createDiv({
			cls: "synchronizer-target-header-row",
		});
		new Setting(headerRow1)
			.setName("Выберите способ синхронизации")
			.setDesc("")
			.addDropdown((d) => {
				Object.entries(methodOptions).forEach(([k, v]) =>
					d.addOption(k, v),
				);
				d.setValue(target.method).onChange(
					async (value: SyncMethod) => {
						target.method = value;
						await this.plugin.saveSettings();
						this.display();
					},
				);
			});

		const removeBtn = headerRow1.createSpan({
			cls: "synchronizer-target-remove",
			attr: { title: "Удалить способ" },
		});
		removeBtn.setText("×");
		removeBtn.onclick = async () => {
			this.plugin.settings.syncTargets =
				this.plugin.settings.syncTargets.filter(
					(t) => t.id !== target.id,
				);
			await this.plugin.saveSettings();
			this.display();
		};

		new Setting(header)
			.setName("Активный метод")
			.setDesc("Участвует в синхронизации по кнопке")
			.addToggle((t) =>
				t.setValue(target.enabled).onChange(async (v) => {
					target.enabled = v;
					await this.plugin.saveSettings();
				}),
			);

		// Папка и направление (общее)
		new Setting(body)
			.setName("Папка на удалённом сервере")
			.setDesc("Путь к папке для синхронизации")
			.addText((text) =>
				text
					.setPlaceholder("Obsidian")
					.setValue(target.folder)
					.onChange(async (value) => {
						target.folder = (value || "Obsidian").replace(
							/^\/+/,
							"",
						);
						await this.plugin.saveSettings();
					}),
			);
		new Setting(body).setName("Направление").addDropdown((d) =>
			d
				.addOption("both", "Двусторонняя")
				.addOption("upload", "Только выгрузка")
				.addOption("download", "Только загрузка")
				.setValue(target.direction)
				.onChange(async (value: SyncDirection) => {
					target.direction = value;
					await this.plugin.saveSettings();
				}),
		);

		if (target.method === "yandex") {
			this.renderYandexSettings(body, target);
		} else if (target.method === "webdav") {
			this.renderWebdavSettings(body, target);
		} else {
			this.renderGoogleDriveSettings(body, target);
		}
	}

	private renderYandexSettings(body: HTMLElement, target: SyncTarget): void {
		const instr = body.createDiv({ cls: "synchronizer-instruction" });
		instr.createEl("strong", { text: "Яндекс.Диск: " });
		instr.appendText(
			"OAuth на oauth.yandex.ru, Redirect URI: https://oauth.yandex.ru/verification_code. Укажите Client ID и получите токен.",
		);
		new Setting(body).setName("Client ID").addText((text) =>
			text
				.setPlaceholder("Client ID")
				.setValue(target.yandexClientId)
				.onChange(async (v) => {
					target.yandexClientId = v;
					await this.plugin.saveSettings();
				}),
		);
		new Setting(body).setName("OAuth-токен").addText((text) => {
			text.setPlaceholder("Токен")
				.setValue(target.yandexAccessToken)
				.onChange(async (v) => {
					target.yandexAccessToken = v;
					await this.plugin.saveSettings();
				});
			text.inputEl.type = "password";
		});
		new Setting(body).setName("Получить токен").addButton((btn) =>
			btn.setButtonText("Открыть страницу авторизации").onClick(() => {
				const id = target.yandexClientId?.trim();
				if (!id) return;
				window.open(YANDEX_AUTH_URL + encodeURIComponent(id), "_blank");
			}),
		);
	}

	private renderWebdavSettings(body: HTMLElement, target: SyncTarget): void {
		const instr = body.createDiv({ cls: "synchronizer-instruction" });
		instr.appendText(
			"Nextcloud, ownCloud, Яндекс (https://webdav.yandex.ru) и др.",
		);
		new Setting(body).setName("WebDAV URL").addText((text) =>
			text
				.setPlaceholder("https://webdav.example.com/")
				.setValue(target.webdavUrl)
				.onChange(async (v) => {
					target.webdavUrl = (v || "").trim();
					await this.plugin.saveSettings();
				}),
		);
		new Setting(body).setName("Логин").addText((text) =>
			text.setValue(target.webdavLogin).onChange(async (v) => {
				target.webdavLogin = v;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(body).setName("Пароль").addText((text) => {
			text.setValue(target.webdavPassword).onChange(async (v) => {
				target.webdavPassword = v;
				await this.plugin.saveSettings();
			});
			text.inputEl.type = "password";
		});
	}

	private renderGoogleDriveSettings(
		body: HTMLElement,
		target: SyncTarget,
	): void {
		const instr = body.createDiv({ cls: "synchronizer-instruction" });
		instr.appendText(
			`Веб-приложение в Google Cloud, Redirect URI: ${GOOGLE_REDIRECT_URI}. Client ID, Secret, затем код из браузера → «Получить токены».`,
		);
		new Setting(body).setName("Client ID").addText((text) =>
			text.setValue(target.googleDriveClientId).onChange(async (v) => {
				target.googleDriveClientId = v;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(body).setName("Client Secret").addText((text) => {
			text.setValue(target.googleDriveClientSecret).onChange(
				async (v) => {
					target.googleDriveClientSecret = v;
					await this.plugin.saveSettings();
				},
			);
			text.inputEl.type = "password";
		});
		new Setting(body).setName("Авторизация").addButton((btn) =>
			btn.setButtonText("Открыть страницу авторизации").onClick(() => {
				const id = target.googleDriveClientId?.trim();
				if (!id) {
					new Notice("Укажите Client ID.");
					return;
				}
				window.open(getGoogleAuthUrl(id), "_blank");
			}),
		);
		let authCode = "";
		const extractCode = (value: string): string => {
			const v = value.trim();
			const match = v.match(/[?&]code=([^&]+)/);
			return match ? decodeURIComponent(match[1] ?? "") : v;
		};
		new Setting(body)
			.setName("Код авторизации")
			.addText((text) =>
				text.setPlaceholder("code=...").onChange((v) => {
					authCode = extractCode(v);
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Получить токены").onClick(async () => {
					const id = target.googleDriveClientId?.trim();
					const secret = target.googleDriveClientSecret?.trim();
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
						const tokens: GoogleDriveTokens =
							await exchangeCodeForTokens(id, secret, code);
						target.googleDriveAccessToken = tokens.access_token;
						target.googleDriveRefreshToken =
							tokens.refresh_token ??
							target.googleDriveRefreshToken;
						target.googleDriveExpiryDate = tokens.expiry_date ?? 0;
						await this.plugin.saveSettings();
						new Notice("Токены сохранены.");
						this.display();
					} catch (e) {
						new Notice(
							"Ошибка: " +
								(e instanceof Error ? e.message : String(e)),
						);
					}
				}),
			);
	}
}
