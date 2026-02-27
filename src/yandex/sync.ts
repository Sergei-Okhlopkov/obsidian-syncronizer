import { App, TFile } from "obsidian";
import { YandexDiskApi, YandexResource } from "./api";

export type SyncDirection = "upload" | "download" | "both";

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	errors: string[];
}

/** Путь на Диске для файла: базовая папка + относительный путь в хранилище */
function remotePath(baseFolder: string, relativePath: string): string {
	const base = baseFolder.replace(/^\/+/, "").replace(/\/+$/, "") || "Obsidian";
	const rel = relativePath.replace(/^\/+/, "");
	return base ? `${base}/${rel}` : rel;
}

/** Относительный путь в хранилище по пути на Диске */
function localRelativePath(baseFolder: string, diskPath: string): string {
	const base = baseFolder.replace(/^\/+/, "").replace(/\/+$/, "") || "Obsidian";
	const norm = diskPath.replace(/^disk:/, "").replace(/^\/+/, "");
	if (!base || !norm.startsWith(base + "/")) return norm;
	return norm.slice(base.length + 1);
}

export async function syncWithYandex(
	app: App,
	accessToken: string,
	baseFolder: string,
	direction: SyncDirection
): Promise<SyncResult> {
	const api = new YandexDiskApi(accessToken);
	const result: SyncResult = { uploaded: 0, downloaded: 0, errors: [] };

	const files = app.vault.getFiles();
	const localMap = new Map<string, number>(); // path -> mtime
	for (const f of files) {
		localMap.set(f.path, f.stat.mtime);
	}

	let remoteFiles: YandexResource[] = [];
	try {
		remoteFiles = await api.listAllFiles(baseFolder);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("404") || msg.includes("Not Found")) {
			try {
				await api.createFolder(baseFolder);
			} catch (createErr) {
				result.errors.push(
					"Не удалось создать папку на Диске: " +
						(createErr instanceof Error ? createErr.message : String(createErr))
				);
				return result;
			}
			remoteFiles = [];
		} else {
			result.errors.push("Список файлов с Диска: " + msg);
			return result;
		}
	}

	const remoteMap = new Map<string, number>(); // relative path -> mtime
	for (const r of remoteFiles) {
		const rel = localRelativePath(baseFolder, r.path);
		const t = r.modified ? new Date(r.modified).getTime() / 1000 : 0;
		remoteMap.set(rel, t);
	}

	// Загрузка на Диск (upload)
	if (direction === "upload" || direction === "both") {
		for (const [path, mtime] of localMap) {
			const remote = remotePath(baseFolder, path);
			const remoteTime = remoteMap.get(path) ?? 0;
			if (mtime <= remoteTime) continue;
			try {
				const content = await app.vault.adapter.read(path);
				const href = await api.getUploadUrl(remote, true);
				await api.uploadToUrl(href, content);
				result.uploaded++;
			} catch (e) {
				result.errors.push(
					`Выгрузка ${path}: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		}
	}

	// Загрузка с Диска (download)
	if (direction === "download" || direction === "both") {
		for (const r of remoteFiles) {
			const rel = localRelativePath(baseFolder, r.path);
			const localTime = localMap.get(rel) ?? 0;
			const remoteTime = r.modified
				? Math.floor(new Date(r.modified).getTime() / 1000)
				: 0;
			if (remoteTime <= localTime) continue;
			try {
				const href = await api.getDownloadUrl(r.path.replace(/^disk:/, "").replace(/^\/+/, ""));
				const buf = await api.downloadFromUrl(href);
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
