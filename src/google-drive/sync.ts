import { App } from "obsidian";
import { GoogleDriveApi } from "./api";
import type { SyncDirection, SyncResult } from "../yandex/sync";

/** Нормализовать путь: слэши в одну сторону, без ведущего слэша */
function normPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+/, "") || "";
}

/** Относительный путь в хранилище по пути на Google Drive (уже относительно базовой папки) */
function toRelativePath(remotePath: string, baseFolder: string): string {
	const base = normPath(baseFolder);
	const remote = normPath(remotePath);
	if (!base) return remote;
	if (remote === base) return "";
	if (remote.startsWith(base + "/")) return remote.slice(base.length + 1);
	return remote;
}

export async function syncWithGoogleDrive(
	app: App,
	api: GoogleDriveApi,
	baseFolder: string,
	direction: SyncDirection
): Promise<SyncResult> {
	const result = { uploaded: 0, downloaded: 0, errors: [] as string[] };
	const folderPath = normPath(baseFolder) || "Obsidian";
	const baseFolderId = await api.getOrCreateFolderByPath(folderPath);

	const localFiles = app.vault.getFiles();
	const localMap = new Map<string, number>();
	for (const f of localFiles) {
		localMap.set(f.path, f.stat.mtime);
	}

	let remoteList: { path: string; id: string; modifiedTime: number }[];
	try {
		remoteList = await api.listAllFilesRecursive(baseFolderId, "");
	} catch (e) {
		result.errors.push(
			"Список файлов с Google Drive: " + (e instanceof Error ? e.message : String(e))
		);
		return result;
	}

	// Пути на удалённой стороне относительно базовой папки (например "note.md", "sub/note.md")
	const remoteMap = new Map<string, { id: string; modifiedTime: number }>();
	for (const r of remoteList) {
		const rel = toRelativePath(r.path, folderPath);
		if (rel === "") continue; // сама базовая папка
		remoteMap.set(rel, { id: r.id, modifiedTime: r.modifiedTime });
	}

	// Загрузка в Google Drive (upload)
	if (direction === "upload" || direction === "both") {
		for (const [path, mtime] of localMap) {
			const remote = remoteMap.get(path);
			const remoteTime = remote?.modifiedTime ?? 0;
			if (mtime <= remoteTime) continue;
			try {
				const content = await app.vault.adapter.read(path);
				await api.uploadFileByPath(baseFolderId, path, content);
				result.uploaded++;
			} catch (e) {
				result.errors.push(
					`Выгрузка ${path}: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		}
	}

	// Загрузка с Google Drive (download)
	if (direction === "download" || direction === "both") {
		for (const [rel, { id, modifiedTime }] of remoteMap) {
			const localTime = localMap.get(rel) ?? 0;
			if (modifiedTime <= localTime) continue;
			try {
				const content = await api.downloadFile(id);
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
