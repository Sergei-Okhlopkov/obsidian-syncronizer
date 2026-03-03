/**
 * Клиент Google Drive API v3
 * https://developers.google.com/drive/api/v3/reference
 */

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_API_BASE = "https://www.googleapis.com/upload/drive/v3";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = "https://www.googleapis.com/auth/drive.file";

/** URI перенаправления после авторизации. Должен быть добавлен в Google Cloud Console в «Authorized redirect URIs». */
export const GOOGLE_REDIRECT_URI = "http://127.0.0.1:8080";

export interface GoogleDriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	parents?: string[];
}

export interface GoogleDriveTokens {
	access_token: string;
	refresh_token?: string;
	expiry_date?: number;
}

export class GoogleDriveApiError extends Error {
	constructor(
		message: string,
		public status?: number,
		public body?: string
	) {
		super(message);
		this.name = "GoogleDriveApiError";
	}
}

/** Собрать URL авторизации для получения кода */
export function getGoogleAuthUrl(
	clientId: string,
	redirectUri: string = GOOGLE_REDIRECT_URI
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: SCOPES,
		access_type: "offline",
		prompt: "consent",
	});
	return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

/** Обмен кода на токены */
export async function exchangeCodeForTokens(
	clientId: string,
	clientSecret: string,
	code: string,
	redirectUri: string = GOOGLE_REDIRECT_URI
): Promise<GoogleDriveTokens> {
	const res = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code: code.trim(),
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}).toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new GoogleDriveApiError(
			`Token exchange failed: ${res.status} ${text}`,
			res.status,
			text
		);
	}
	const data = JSON.parse(text) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};
	const expiry = data.expires_in
		? Date.now() + data.expires_in * 1000
		: undefined;
	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expiry_date: expiry,
	};
}

/** Обновить access_token по refresh_token */
export async function refreshAccessToken(
	clientId: string,
	clientSecret: string,
	refreshToken: string
): Promise<GoogleDriveTokens> {
	const res = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}).toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new GoogleDriveApiError(
			`Token refresh failed: ${res.status} ${text}`,
			res.status,
			text
		);
	}
	const data = JSON.parse(text) as {
		access_token: string;
		expires_in?: number;
	};
	const expiry = data.expires_in
		? Date.now() + data.expires_in * 1000
		: undefined;
	return {
		access_token: data.access_token,
		refresh_token: refreshToken,
		expiry_date: expiry,
	};
}

export class GoogleDriveApi {
	private accessToken: string;
	private refreshToken?: string;
	private expiryDate?: number;
	constructor(
		tokens: GoogleDriveTokens,
		private clientId: string,
		private clientSecret: string
	) {
		this.accessToken = tokens.access_token.trim();
		this.refreshToken = tokens.refresh_token;
		this.expiryDate = tokens.expiry_date;
	}

	/** Обновить токен при необходимости и выполнить запрос */
	private async ensureTokenAndRequest<T>(
		url: string,
		options: RequestInit = {}
	): Promise<T> {
		const margin = 60 * 1000; // обновить за минуту до истечения
		if (
			this.expiryDate &&
			Date.now() >= this.expiryDate - margin &&
			this.refreshToken
		) {
			const newTokens = await refreshAccessToken(
				this.clientId,
				this.clientSecret,
				this.refreshToken
			);
			this.accessToken = newTokens.access_token;
			this.expiryDate = newTokens.expiry_date;
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.accessToken}`,
			...((options.headers as Record<string, string>) ?? {}),
		};
		const res = await fetch(url, { ...options, headers });
		const text = await res.text();
		if (res.status === 401 && this.refreshToken) {
			const newTokens = await refreshAccessToken(
				this.clientId,
				this.clientSecret,
				this.refreshToken
			);
			this.accessToken = newTokens.access_token;
			this.expiryDate = newTokens.expiry_date;
			return this.ensureTokenAndRequest(url, options);
		}
		if (!res.ok) {
			throw new GoogleDriveApiError(
				`API error ${res.status}: ${text}`,
				res.status,
				text
			);
		}
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			return undefined as T;
		}
	}

	/** Список файлов в папке (один уровень) */
	async listFiles(
		parentId: string,
		pageToken?: string
	): Promise<{ files: GoogleDriveFile[]; nextPageToken?: string }> {
		const q = `'${parentId}' in parents and trashed = false`;
		const params = new URLSearchParams({
			q,
			fields: "nextPageToken, files(id, name, mimeType, modifiedTime, parents)",
			pageSize: "1000",
		});
		if (pageToken) params.set("pageToken", pageToken);
		const url = `${DRIVE_API_BASE}/files?${params.toString()}`;
		const data = await this.ensureTokenAndRequest<{
			files: GoogleDriveFile[];
			nextPageToken?: string;
		}>(url);
		return data ?? { files: [] };
	}

	/** Рекурсивно собрать все файлы (не папки) под данной папкой. Путь относительно basePath. */
	async listAllFilesRecursive(
		parentId: string,
		basePath: string
	): Promise<{ path: string; id: string; modifiedTime: number }[]> {
		const result: { path: string; id: string; modifiedTime: number }[] = [];
		const stack: { id: string; path: string }[] = [{ id: parentId, path: basePath }];

		while (stack.length > 0) {
			const { id: folderId, path: currentPath } = stack.pop()!;
			let pageToken: string | undefined;
			do {
				const { files, nextPageToken } = await this.listFiles(folderId, pageToken);
				pageToken = nextPageToken;
				for (const f of files) {
					const childPath = currentPath ? `${currentPath}/${f.name}` : f.name;
					if (f.mimeType === "application/vnd.google-apps.folder") {
						stack.push({ id: f.id, path: childPath });
					} else {
						const mtime = f.modifiedTime
							? new Date(f.modifiedTime).getTime() / 1000
							: 0;
						result.push({ path: childPath, id: f.id, modifiedTime: mtime });
					}
				}
			} while (pageToken);
		}
		return result;
	}

	/** Найти или создать папку по имени в родительской папке */
	async getOrCreateFolder(parentId: string, folderName: string): Promise<string> {
		const { files } = await this.listFiles(parentId);
		const existing = files.find(
			(f) => f.name === folderName && f.mimeType === "application/vnd.google-apps.folder"
		);
		if (existing) return existing.id;
		const created = await this.createFolder(parentId, folderName);
		return created.id;
	}

	/** Создать папку */
	async createFolder(parentId: string, name: string): Promise<GoogleDriveFile> {
		const url = DRIVE_API_BASE + "/files";
		const body = {
			name,
			mimeType: "application/vnd.google-apps.folder",
			parents: [parentId],
		};
		const data = await this.ensureTokenAndRequest<GoogleDriveFile>(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!data?.id) throw new GoogleDriveApiError("Failed to create folder");
		return data;
	}

	/** Получить или создать папку по пути (например "Obsidian" или "Backup/Obsidian") */
	async getOrCreateFolderByPath(path: string): Promise<string> {
		const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
		let parentId = "root";
		for (const segment of segments) {
			parentId = await this.getOrCreateFolder(parentId, segment);
		}
		return parentId;
	}

	/** Загрузить файл (создать или обновить по имени в папке) */
	async uploadFile(
		parentId: string,
		fileName: string,
		content: string,
		mimeType: string = "text/plain; charset=utf-8"
	): Promise<void> {
		const { files } = await this.listFiles(parentId);
		const existing = files.find((f) => f.name === fileName && f.mimeType !== "application/vnd.google-apps.folder");
		if (existing) {
			await this.ensureTokenAndRequest(
				`${UPLOAD_API_BASE}/files/${existing.id}?uploadType=media`,
				{
					method: "PATCH",
					headers: { "Content-Type": mimeType },
					body: content,
				}
			);
		} else {
			const created = await this.ensureTokenAndRequest<GoogleDriveFile>(
				DRIVE_API_BASE + "/files",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: fileName,
						parents: [parentId],
					}),
				}
			);
			if (created?.id) {
				await this.ensureTokenAndRequest(
					`${UPLOAD_API_BASE}/files/${created.id}?uploadType=media`,
					{
						method: "PATCH",
						headers: { "Content-Type": mimeType },
						body: content,
					}
				);
			}
		}
	}

	/** Загрузить файл в папку по пути (создавая вложенные папки) */
	async uploadFileByPath(
		baseFolderId: string,
		relativePath: string,
		content: string
	): Promise<void> {
		const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0) return;
		const fileName = parts.pop()!;
		let parentId = baseFolderId;
		for (const segment of parts) {
			parentId = await this.getOrCreateFolder(parentId, segment);
		}
		await this.uploadFile(parentId, fileName, content);
	}

	/** Скачать содержимое файла по ID */
	async downloadFile(fileId: string): Promise<string> {
		const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.accessToken}` },
		});
		if (!res.ok) {
			const text = await res.text();
			throw new GoogleDriveApiError(
				`Download failed: ${res.status} ${text}`,
				res.status,
				text
			);
		}
		return res.text();
	}

	/** Текущие токены (для сохранения после refresh) */
	getTokens(): GoogleDriveTokens {
		return {
			access_token: this.accessToken,
			refresh_token: this.refreshToken,
			expiry_date: this.expiryDate,
		};
	}
}
