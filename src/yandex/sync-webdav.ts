import { App } from "obsidian";
import { YandexWebdavClient, WebdavResource } from "./webdav";
import type { SyncDirection, SyncResult } from "./sync";

function remotePath(baseFolder: string, relativePath: string): string {
	const base = baseFolder.replace(/^\/+/, "").replace(/\/+$/, "") || "Obsidian";
	const rel = relativePath.replace(/^\/+/, "");
	return base ? `${base}/${rel}` : rel;
}

function localRelativePath(baseFolder: string, diskPath: string): string {
	const base = baseFolder.replace(/^\/+/, "").replace(/\/+$/, "") || "Obsidian";
	const norm = diskPath.replace(/^\/+/, "");
	if (!base || !norm.startsWith(base + "/")) return norm;
	return norm.slice(base.length + 1);
}

export async function syncWithYandexWebdav(
	app: App,
	baseUrl: string,
	login: string,
	password: string,
	baseFolder: string,
	direction: SyncDirection
): Promise<SyncResult> {
	const client = new YandexWebdavClient(baseUrl, login, password, app);
	const result: SyncResult = { uploaded: 0, downloaded: 0, errors: [] };

	const files = app.vault.getFiles();
	const localMap = new Map<string, number>();
	for (const f of files) {
		localMap.set(f.path, f.stat.mtime);
	}

	const base = baseFolder.replace(/^\/+/, "").replace(/\/+$/, "") || "Obsidian";
	let remoteFiles: WebdavResource[] = [];
	try {
		remoteFiles = await client.listAllFiles(base);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("404") || msg.includes("401") || msg.includes("403")) {
			try {
				await client.createFolder(base);
			} catch (createErr) {
				result.errors.push(
					"Не удалось создать папку на удалённом сервере: " +
						(createErr instanceof Error ? createErr.message : String(createErr))
				);
				return result;
			}
			remoteFiles = [];
		} else {
			result.errors.push("Список файлов с удалённого сервера: " + msg);
			return result;
		}
	}

	const remoteMap = new Map<string, number>();
	for (const r of remoteFiles) {
		const rel = r.path; // уже относительно baseFolder
		const t = r.modified ? new Date(r.modified).getTime() / 1000 : 0;
		remoteMap.set(rel, t);
	}

	if (direction === "upload" || direction === "both") {
		for (const [path, mtime] of localMap) {
			const remote = remotePath(baseFolder, path);
			const remoteTime = remoteMap.get(path) ?? 0;
			if (mtime <= remoteTime) continue;
			try {
				const content = await app.vault.adapter.read(path);
				await client.put(remote, content);
				result.uploaded++;
			} catch (e) {
				result.errors.push(
					`Выгрузка ${path}: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		}
	}

	if (direction === "download" || direction === "both") {
		for (const r of remoteFiles) {
			const rel = r.path;
			const localTime = localMap.get(rel) ?? 0;
			const remoteTime = r.modified
				? Math.floor(new Date(r.modified).getTime() / 1000)
				: 0;
			if (remoteTime <= localTime) continue;
			try {
				const fullRemote = base ? `${base}/${rel}` : rel;
				const buf = await client.get(fullRemote);
				const content = new TextDecoder("utf-8").decode(buf);
				await app.vault.adapter.write(rel, content);
				result.downloaded++;
			} catch (e) {
				result.errors.push(
					`Загрузка ${rel}: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		}
	}

	return result;
}
