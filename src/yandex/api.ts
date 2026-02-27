/**
 * Клиент REST API Яндекс.Диска
 * https://yandex.com/dev/disk-api/doc/en/
 */

const API_BASE = "https://cloud-api.yandex.net/v1/disk";

export interface YandexResource {
	name: string;
	path: string;
	type: "file" | "dir";
	size?: number;
	modified?: string;
	_embedded?: {
		items: YandexResource[];
	};
}

export interface YandexLink {
	href: string;
	method: string;
	templated: boolean;
}

export class YandexDiskApiError extends Error {
	constructor(
		message: string,
		public status?: number,
		public body?: string
	) {
		super(message);
		this.name = "YandexDiskApiError";
	}
}

export class YandexDiskApi {
	constructor(accessToken: string) {
		// Убираем пробелы и переносы — токен часто копируют с лишними символами
		this.accessToken = accessToken.trim().replace(/\s+/g, "");
	}
	private accessToken: string;

	private async request<T>(
		method: string,
		path: string,
		options?: { params?: Record<string, string>; body?: unknown }
	): Promise<T> {
		const url = new URL(API_BASE + path);
		if (options?.params) {
			for (const [k, v] of Object.entries(options.params)) {
				url.searchParams.set(k, v);
			}
		}
		const hasBody = options?.body !== undefined && options?.body !== null;
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `OAuth ${this.accessToken}`,
		};
		if (hasBody) {
			headers["Content-Type"] = "application/json";
		}
		const res = await fetch(url.toString(), {
			method,
			headers,
			body: hasBody ? JSON.stringify(options!.body) : undefined,
		});
		const text = await res.text();
		if (!res.ok) {
			throw new YandexDiskApiError(
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

	/** Проверка токена и доступа к Диску */
	async getDiskInfo(): Promise<{ total_space: number; used_space: number }> {
		const data = await this.request<{ total_space: number; used_space: number }>(
			"GET",
			""
		);
		return data ?? { total_space: 0, used_space: 0 };
	}

	/** Метаданные ресурса (файл или папка). Для папки можно запросить _embedded. */
	async getResource(
		path: string,
		options?: { limit?: number; offset?: number }
	): Promise<YandexResource> {
		const params: Record<string, string> = {
			path: path.startsWith("/") ? path : "/" + path,
			fields: "name,path,type,size,modified,_embedded.items.name,_embedded.items.path,_embedded.items.type,_embedded.items.size,_embedded.items.modified",
		};
		if (options?.limit != null) params.limit = String(options.limit);
		if (options?.offset != null) params.offset = String(options.offset);
		const data = await this.request<YandexResource>("GET", "/resources", {
			params,
		});
		if (!data) throw new YandexDiskApiError("Empty resource response");
		return data;
	}

	/** Нормализовать путь (убрать disk: и ведущий слэш) */
	private static normPath(p: string): string {
		return p.replace(/^disk:/, "").replace(/^\/+/, "") || "";
	}

	/** Рекурсивный список всех файлов в папке */
	async listAllFiles(folderPath: string): Promise<YandexResource[]> {
		const norm = YandexDiskApi.normPath(folderPath) || "/";
		const result: YandexResource[] = [];
		let offset = 0;
		const limit = 1000;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const resource = await this.getResource(norm === "/" ? "" : norm, {
				limit,
				offset,
			});
			const items = resource._embedded?.items ?? [];
			if (items.length === 0) break;
			for (const item of items) {
				if (item.type === "dir") {
					const sub = await this.listAllFiles(
						YandexDiskApi.normPath(item.path)
					);
					result.push(...sub);
				} else {
					result.push(item);
				}
			}
			if (items.length < limit) break;
			offset += limit;
		}
		return result;
	}

	/** Получить URL для загрузки файла на Диск. Путь передаётся как есть — кодирование делает URLSearchParams. */
	async getUploadUrl(remotePath: string, overwrite = true): Promise<string> {
		const path = remotePath.startsWith("/") ? remotePath : "/" + remotePath;
		const data = await this.request<{ href: string }>(
			"GET",
			"/resources/upload",
			{
				params: {
					path,
					overwrite: String(overwrite),
				},
			}
		);
		if (!data?.href) throw new YandexDiskApiError("No upload href in response");
		return data.href;
	}

	/** Загрузить файл по URL (полученному от getUploadUrl) */
	async uploadToUrl(href: string, body: ArrayBuffer | string): Promise<void> {
		const res = await fetch(href, {
			method: "PUT",
			body: body as BodyInit,
			headers:
				typeof body === "string"
					? { "Content-Type": "text/plain; charset=utf-8" }
					: undefined,
		});
		if (res.status !== 201 && res.status !== 202) {
			const text = await res.text();
			throw new YandexDiskApiError(`Upload failed: ${res.status} ${text}`, res.status, text);
		}
	}

	/** Получить URL для скачивания файла. Путь передаётся как есть — кодирование делает URLSearchParams. */
	async getDownloadUrl(remotePath: string): Promise<string> {
		const path = remotePath.startsWith("/") ? remotePath : "/" + remotePath;
		const data = await this.request<{ href: string }>(
			"GET",
			"/resources/download",
			{ params: { path } }
		);
		if (!data?.href) throw new YandexDiskApiError("No download href in response");
		return data.href;
	}

	/** Скачать файл по URL (полученному от getDownloadUrl) */
	async downloadFromUrl(href: string): Promise<ArrayBuffer> {
		const res = await fetch(href, {
			headers: { Authorization: `OAuth ${this.accessToken}` },
		});
		if (!res.ok) {
			const text = await res.text();
			throw new YandexDiskApiError(
				`Download failed: ${res.status} ${text}`,
				res.status,
				text
			);
		}
		return res.arrayBuffer();
	}

	/** Создать папку. Путь передаётся как есть — кодирование делает URLSearchParams. */
	async createFolder(remotePath: string): Promise<void> {
		const path = remotePath.startsWith("/") ? remotePath : "/" + remotePath;
		await this.request("PUT", "/resources", {
			params: { path },
		});
	}
}
