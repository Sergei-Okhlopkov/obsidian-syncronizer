/**
 * WebDAV-клиент для Яндекс.Диска
 * https://yandex.com/dev/disk/doc/en/reference/propfind.html
 */

export interface WebdavResource {
	path: string;   // путь относительно корня (без ведущего /)
	type: "file" | "dir";
	modified?: string; // ISO date
	size?: number;
}

function normPath(p: string): string {
	return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

function parsePropfindXml(xmlText: string, basePath: string): WebdavResource[] {
	const results: WebdavResource[] = [];
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlText, "text/xml");
	const responses = doc.getElementsByTagNameNS("DAV:", "response");
	const baseNorm = normPath(basePath);
	const basePrefix = baseNorm ? baseNorm + "/" : "";

	for (let i = 0; i < responses.length; i++) {
		const res = responses[i];
		if (!res) continue;
		const hrefEl = res.getElementsByTagNameNS("DAV:", "href")[0];
		if (!hrefEl?.textContent) continue;

		let path = decodeURIComponent(hrefEl.textContent.trim());
		// Убрать ведущий слэш и хост, оставить путь
		try {
			if (path.startsWith("http")) {
				const u = new URL(path);
				path = u.pathname;
			}
		} catch {
			// не URL
		}
		path = path.replace(/^\/+/, "").replace(/\/+$/, "");

		// Пропустить корень
		if (!path) continue;
		// Только сама папка или её содержимое
		if (baseNorm && path !== baseNorm && !path.startsWith(basePrefix)) continue;
		// Пропустить саму запрошенную папку (response для неё — это «текущая директория»)
		if (baseNorm && path === baseNorm) continue;

		const propstat = res.getElementsByTagNameNS("DAV:", "propstat")[0];
		if (!propstat) continue;

		const prop = propstat.getElementsByTagNameNS("DAV:", "prop")[0];
		if (!prop) continue;

		const resourcetype = prop.getElementsByTagNameNS("DAV:", "resourcetype")[0];
		const collection =
			(resourcetype?.getElementsByTagNameNS("DAV:", "collection")?.length ?? 0) > 0;
		const getlastmodified = prop.getElementsByTagNameNS("DAV:", "getlastmodified")[0];
		const getcontentlength = prop.getElementsByTagNameNS("DAV:", "getcontentlength")[0];
		const modified = getlastmodified?.textContent?.trim();
		const size = getcontentlength?.textContent ? parseInt(getcontentlength.textContent, 10) : undefined;

		// Относительный путь от базовой папки (для listDir — имя элемента)
		const relativePath = baseNorm && path.startsWith(basePrefix) ? path.slice(basePrefix.length) : path;

		results.push({
			path: relativePath,
			type: collection ? "dir" : "file",
			modified: modified || undefined,
			size: size ?? undefined,
		});
	}
	return results;
}

/** Рекурсивно собрать все файлы; parentPrefix — путь родителя относительно baseFolder */
async function collectFiles(
	resources: WebdavResource[],
	currentDirPath: string,
	parentPrefix: string,
	client: YandexWebdavClient
): Promise<WebdavResource[]> {
	const files: WebdavResource[] = [];
	const dirs: WebdavResource[] = [];
	for (const r of resources) {
		if (r.type === "file") {
			files.push({ ...r, path: parentPrefix ? parentPrefix + "/" + r.path : r.path });
		} else if (r.type === "dir") {
			dirs.push(r);
		}
	}
	for (const d of dirs) {
		const fullPath = currentDirPath ? currentDirPath + "/" + d.path : d.path;
		const prefix = parentPrefix ? parentPrefix + "/" + d.path : d.path;
		const sub = await client.listDir(fullPath);
		const subFiles = await collectFiles(sub, fullPath, prefix, client);
		files.push(...subFiles);
	}
	return files;
}

export class YandexWebdavError extends Error {
	constructor(
		message: string,
		public status?: number,
		public body?: string
	) {
		super(message);
		this.name = "YandexWebdavError";
	}
}

export class YandexWebdavClient {
	private baseUrl: string;
	private authHeader: string;

	constructor(baseUrl: string, login: string, password: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		const credentials = btoa(unescape(encodeURIComponent(login + ":" + password)));
		this.authHeader = "Basic " + credentials;
	}

	private async request(
		method: string,
		path: string,
		options?: { body?: string; headers?: Record<string, string>; depth?: number }
	): Promise<Response> {
		const url = path ? `${this.baseUrl}/${path.replace(/^\/+/, "")}` : this.baseUrl;
		const headers: Record<string, string> = {
			Authorization: this.authHeader,
			...options?.headers,
		};
		if (options?.depth != null) headers["Depth"] = String(options.depth);
		const res = await fetch(url, {
			method,
			headers,
			body: options?.body,
		});
		return res;
	}

	/** Список элементов в папке (файлы и подпапки) */
	async listDir(remotePath: string): Promise<WebdavResource[]> {
		const path = normPath(remotePath) || "";
		const res = await this.request("PROPFIND", path, {
			depth: 1,
			headers: { "Content-Type": "application/xml; charset=utf-8" },
			body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getlastmodified/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`,
		});
		const text = await res.text();
		if (!res.ok) {
			throw new YandexWebdavError(`PROPFIND failed: ${res.status} ${text}`, res.status, text);
		}
		return parsePropfindXml(text, path);
	}

	/** Рекурсивно все файлы в папке (пути относительно baseFolder) */
	async listAllFiles(baseFolder: string): Promise<WebdavResource[]> {
		const base = normPath(baseFolder) || "";
		const top = await this.listDir(base);
		return collectFiles(top, base, "", this);
	}

	/** Скачать файл */
	async get(remotePath: string): Promise<ArrayBuffer> {
		const path = normPath(remotePath);
		const res = await this.request("GET", path);
		if (!res.ok) {
			const text = await res.text();
			throw new YandexWebdavError(`GET failed: ${res.status} ${text}`, res.status, text);
		}
		return res.arrayBuffer();
	}

	/** Загрузить файл */
	async put(remotePath: string, body: ArrayBuffer | string): Promise<void> {
		const path = normPath(remotePath);
		const parts = path.split("/");
		if (parts.length > 1) {
			let acc = "";
			for (let i = 0; i < parts.length - 1; i++) {
				acc += (acc ? "/" : "") + parts[i];
				await this.mkcol(acc);
			}
		}
		const url = path ? `${this.baseUrl}/${path}` : this.baseUrl;
		const headers: Record<string, string> = { Authorization: this.authHeader };
		if (typeof body === "string") {
			headers["Content-Type"] = "text/plain; charset=utf-8";
		}
		const res = await fetch(url, {
			method: "PUT",
			headers,
			body: body as BodyInit,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new YandexWebdavError(`PUT failed: ${res.status} ${text}`, res.status, text);
		}
	}

	/** Создать папку (MKCOL) */
	async mkcol(remotePath: string): Promise<void> {
		const path = normPath(remotePath);
		if (!path) return;
		const res = await this.request("MKCOL", path);
		if (res.status === 201 || res.status === 204) return;
		if (res.status === 405) return; // уже существует
		const text = await res.text();
		throw new YandexWebdavError(`MKCOL failed: ${res.status} ${text}`, res.status, text);
	}

	/** Создать папку и все родительские */
	async createFolder(remotePath: string): Promise<void> {
		const path = normPath(remotePath);
		if (!path) return;
		const parts = path.split("/").filter(Boolean);
		let acc = "";
		for (const p of parts) {
			acc += (acc ? "/" : "") + p;
			await this.mkcol(acc);
		}
	}
}
