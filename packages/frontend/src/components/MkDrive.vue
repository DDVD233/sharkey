<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header>
		<nav :class="$style.nav">
			<div :class="$style.navPath" @contextmenu.prevent.stop="() => {}">
				<XNavFolder
					:class="[$style.navPathItem, { [$style.navCurrent]: folder == null }]"
					:parentFolder="folder"
					@move="move"
					@upload="upload"
					@removeFile="removeFile"
					@removeFolder="removeFolder"
				/>
				<template v-for="f in hierarchyFolders">
					<span :class="[$style.navPathItem, $style.navSeparator]"><i class="ti ti-chevron-right"></i></span>
					<XNavFolder
						:folder="f"
						:parentFolder="folder"
						:class="[$style.navPathItem]"
						@move="move"
						@upload="upload"
						@removeFile="removeFile"
						@removeFolder="removeFolder"
					/>
				</template>
				<span v-if="folder != null" :class="[$style.navPathItem, $style.navSeparator]"><i class="ti ti-chevron-right"></i></span>
				<span v-if="folder != null" :class="[$style.navPathItem, $style.navCurrent]">{{ folder.name }}</span>
			</div>
			<div :class="$style.navMenu">
				<!-- "Search drive via alt text or file names" -->
				<MkInput v-model="searchQuery" :large="true" :autofocus="true" type="search" :placeholder="i18n.ts.driveSearchbarPlaceholder" @enter="fetch">
					<template #prefix><i class="ph-magnifying-glass ph-bold ph-lg"></i></template>
				</MkInput>

				<button class="_button" :class="$style.navMenu" @click="showMenu"><i class="ti ti-dots"></i></button>
			</div>
		</nav>
		<div v-if="browseMode && selectionCount > 0" :class="$style.selectionBar">
			<span :class="$style.selectionCount">{{ selectionCount }}</span>
			<MkButton inline rounded small @click="moveSelection"><i class="ti ti-folder-symlink"></i> {{ i18n.ts.move }}</MkButton>
			<MkButton inline rounded small :disabled="selectedFiles.length === 0" @click="downloadSelection"><i class="ti ti-download"></i> {{ i18n.ts.download }}</MkButton>
			<MkButton inline rounded small danger @click="deleteSelection"><i class="ti ti-trash"></i> {{ i18n.ts.delete }}</MkButton>
			<button class="_button" :class="$style.selectionClear" @click="clearSelection"><i class="ti ti-x"></i></button>
		</div>
	</template>

	<div
		ref="main"
		:class="[$style.main, { [$style.uploading]: uploadings.length > 0, [$style.fetching]: fetching }]"
		@dragover.prevent.stop="onDragover"
		@dragenter="onDragenter"
		@dragleave="onDragleave"
		@drop.prevent.stop="onDrop"
		@contextmenu.stop="onContextmenu"
		@mousedown="onBgMousedown"
	>
		<div ref="contents">
			<MkInfo v-if="!store.r.readDriveTip.value" closable @close="closeTip()"><div v-html="i18n.ts.driveAboutTip"></div></MkInfo>
			<div v-show="folders.length > 0" ref="foldersContainer" :class="$style.folders">
				<XFolder
					v-for="(f, i) in folders"
					:key="f.id"
					v-anim="i"
					:class="$style.folder"
					:folder="f"
					:selectMode="select === 'folder'"
					:browseSelectMode="browseMode"
					:isSelected="selectedFolders.some(x => x.id === f.id)"
					@chosen="chooseFolder"
					@unchose="unchoseFolder"
					@select="(folder, ev) => browseSelect('folder', folder, ev)"
					@move="move"
					@upload="upload"
					@removeFile="removeFile"
					@removeFolder="removeFolder"
					@dragstart="isDragSource = true"
					@dragend="isDragSource = false"
				/>
				<!-- SEE: https://stackoverflow.com/questions/18744164/flex-box-align-last-row-to-grid -->
				<div v-for="(n, i) in 16" :key="i" :class="$style.padding"></div>
				<MkButton v-if="moreFolders" ref="moreFolders" @click="fetchMoreFolders">{{ i18n.ts.loadMore }}</MkButton>
			</div>
			<div v-show="files.length > 0 && !folderDestinationMode" ref="filesContainer" :class="$style.files">
				<XFile
					v-for="(file, i) in files"
					:key="file.id"
					v-anim="i"
					:class="$style.file"
					:file="file"
					:folder="folder"
					:selectMode="select === 'file'"
					:browseSelectMode="browseMode"
					:isSelected="selectedFiles.some(x => x.id === file.id)"
					@chosen="chooseFile"
					@select="(f, ev) => browseSelect('file', f, ev)"
					@open="openFile"
					@dragstart="(ev) => onFileDragstart(file, ev)"
					@dragend="isDragSource = false"
				/>
				<!-- SEE: https://stackoverflow.com/questions/18744164/flex-box-align-last-row-to-grid -->
				<div v-for="(n, i) in 16" :key="i" :class="$style.padding"></div>
				<MkButton v-show="moreFiles" ref="loadMoreFiles" @click="fetchMoreFiles">{{ i18n.ts.loadMore }}</MkButton>
			</div>
			<div v-if="files.length == 0 && folders.length == 0 && !fetching" :class="$style.empty">
				<div v-if="draghover">{{ i18n.ts['empty-draghover'] }}</div>
				<div v-if="!draghover && folder == null"><strong>{{ i18n.ts.emptyDrive }}</strong><br/>{{ i18n.ts['empty-drive-description'] }}</div>
				<div v-if="!draghover && folder != null">{{ i18n.ts.emptyFolder }}</div>
			</div>
		</div>
		<MkLoading v-if="fetching"/>
	</div>
	<div v-if="draghover" :class="$style.dropzone"></div>
	<Teleport to="body">
		<div
			v-if="rubberband"
			:class="$style.rubberband"
			:style="{ left: rubberband.x + 'px', top: rubberband.y + 'px', width: rubberband.w + 'px', height: rubberband.h + 'px' }"
		></div>
	</Teleport>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import * as Misskey from 'misskey-js';
import MkButton from './MkButton.vue';
import MkInfo from './MkInfo.vue';
import type { MenuItem } from '@/types/menu.js';
import XNavFolder from '@/components/MkDrive.navFolder.vue';
import XFolder from '@/components/MkDrive.folder.vue';
import XFile from '@/components/MkDrive.file.vue';
import MkInput from '@/components/MkInput.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useStream } from '@/stream.js';
import { i18n } from '@/i18n.js';
import { uploadFile, uploads } from '@/utility/upload.js';
import { claimAchievement } from '@/utility/achievements.js';
import { prefer } from '@/preferences.js';
import { chooseFileFromPc } from '@/utility/select-file.js';
import { store } from '@/store.js';
import { deviceKind } from '@/utility/device-kind.js';
import { useRouter } from '@/router.js';

const router = useRouter();

const searchQuery = ref('');

const props = withDefaults(defineProps<{
	initialFolder?: Misskey.entities.DriveFolder;
	type?: string;
	multiple?: boolean;
	select?: 'file' | 'folder' | null;
	// 移動先フォルダをナビゲーションで選ぶモード（チェックボックスなし・ファイル非表示・OKで現在のフォルダを返す）
	folderDestinationMode?: boolean;
}>(), {
	multiple: false,
	select: null,
	folderDestinationMode: false,
});

const emit = defineEmits<{
	(ev: 'selected', v: Misskey.entities.DriveFile | Misskey.entities.DriveFolder): void;
	(ev: 'change-selection', v: Misskey.entities.DriveFile[] | Misskey.entities.DriveFolder[]): void;
	(ev: 'move-root'): void;
	(ev: 'cd', v: Misskey.entities.DriveFolder | null): void;
	(ev: 'open-folder', v: Misskey.entities.DriveFolder): void;
}>();

const loadMoreFiles = useTemplateRef('loadMoreFiles');

const folder = ref<Misskey.entities.DriveFolder | null>(null);
const files = ref<Misskey.entities.DriveFile[]>([]);
const folders = ref<Misskey.entities.DriveFolder[]>([]);
const moreFiles = ref(false);
const moreFolders = ref(false);
const hierarchyFolders = ref<Misskey.entities.DriveFolder[]>([]);
const selectedFiles = ref<Misskey.entities.DriveFile[]>([]);
const selectedFolders = ref<Misskey.entities.DriveFolder[]>([]);
const uploadings = uploads;

const mainEl = useTemplateRef('main');

// ブラウズ（非ピッカー）モードでのみFinder風の選択を有効にする
const browseMode = computed(() => props.select == null && !props.folderDestinationMode);
const selectionCount = computed(() => selectedFiles.value.length + selectedFolders.value.length);
const selectionAnchor = ref<{ kind: 'file' | 'folder'; id: string } | null>(null);

// ラバーバンド（範囲ドラッグ）選択
const rubberband = ref<{ x: number; y: number; w: number; h: number } | null>(null);
const connection = useStream().useChannel('drive');

// ドロップされようとしているか
const draghover = ref(false);

// 自身の所有するアイテムがドラッグをスタートさせたか
// (自分自身の階層にドロップできないようにするためのフラグ)
const isDragSource = ref(false);

const fetching = ref(true);

const ilFilesObserver = new IntersectionObserver(
	(entries) => entries.some((entry) => entry.isIntersecting) && !fetching.value && moreFiles.value && fetchMoreFiles(),
);

const sortModeSelect = ref<NonNullable<Misskey.entities.DriveFilesRequest['sort']>>('+createdAt');

watch(folder, () => emit('cd', folder.value));
watch(sortModeSelect, () => {
	fetch();
});

function onStreamDriveFileCreated(file: Misskey.entities.DriveFile) {
	addFile(file, true);
}

function onStreamDriveFileUpdated(file: Misskey.entities.DriveFile) {
	const current = folder.value ? folder.value.id : null;
	if (current !== file.folderId) {
		removeFile(file);
	} else {
		addFile(file, true);
	}
}

function onStreamDriveFileDeleted(fileId: string) {
	removeFile(fileId);
}

function onStreamDriveFolderCreated(createdFolder: Misskey.entities.DriveFolder) {
	addFolder(createdFolder, true);
}

function onStreamDriveFolderUpdated(updatedFolder: Misskey.entities.DriveFolder) {
	const current = folder.value ? folder.value.id : null;
	if (current !== updatedFolder.parentId) {
		removeFolder(updatedFolder);
	} else {
		addFolder(updatedFolder, true);
	}
}

function onStreamDriveFolderDeleted(folderId: string) {
	removeFolder(folderId);
}

function onDragover(ev: DragEvent) {
	if (!ev.dataTransfer) return;

	// ドラッグ元が自分自身の所有するアイテムだったら
	if (isDragSource.value) {
		// 自分自身にはドロップさせない
		ev.dataTransfer.dropEffect = 'none';
		return;
	}

	const isFile = ev.dataTransfer.items[0].kind === 'file';
	const isDriveFile = ev.dataTransfer.types[0] === _DATA_TRANSFER_DRIVE_FILE_;
	const isDriveFolder = ev.dataTransfer.types[0] === _DATA_TRANSFER_DRIVE_FOLDER_;
	if (isFile || isDriveFile || isDriveFolder) {
		switch (ev.dataTransfer.effectAllowed) {
			case 'all':
			case 'uninitialized':
			case 'copy':
			case 'copyLink':
			case 'copyMove':
				ev.dataTransfer.dropEffect = 'copy';
				break;
			case 'linkMove':
			case 'move':
				ev.dataTransfer.dropEffect = 'move';
				break;
			default:
				ev.dataTransfer.dropEffect = 'none';
				break;
		}
	} else {
		ev.dataTransfer.dropEffect = 'none';
	}

	return false;
}

function onDragenter() {
	if (!isDragSource.value) draghover.value = true;
}

function onDragleave() {
	draghover.value = false;
}

function onDrop(ev: DragEvent) {
	draghover.value = false;

	if (!ev.dataTransfer) return;

	// ドロップされてきたものがファイルだったら
	if (ev.dataTransfer.files.length > 0) {
		for (const file of Array.from(ev.dataTransfer.files)) {
			upload(file, folder.value);
		}
		return;
	}

	//#region ドライブのファイル
	const targetFolderId = folder.value ? folder.value.id : null;
	const driveFileIds = ev.dataTransfer.getData(_DATA_TRANSFER_DRIVE_FILES_);
	if (driveFileIds != null && driveFileIds !== '') {
		// 複数選択ドラッグ: 選択中の全ファイルを移動
		for (const id of JSON.parse(driveFileIds) as string[]) {
			if (files.value.some(f => f.id === id)) continue; // 既に現在のフォルダにある
			removeFile(id);
			misskeyApi('drive/files/update', { fileId: id, folderId: targetFolderId });
		}
	} else {
		const driveFile = ev.dataTransfer.getData(_DATA_TRANSFER_DRIVE_FILE_);
		if (driveFile != null && driveFile !== '') {
			const file = JSON.parse(driveFile);
			if (files.value.some(f => f.id === file.id)) return;
			removeFile(file.id);
			misskeyApi('drive/files/update', {
				fileId: file.id,
				folderId: targetFolderId,
			});
		}
	}
	//#endregion

	//#region ドライブのフォルダ
	const driveFolder = ev.dataTransfer.getData(_DATA_TRANSFER_DRIVE_FOLDER_);
	if (driveFolder != null && driveFolder !== '') {
		const droppedFolder = JSON.parse(driveFolder);

		// 移動先が自分自身ならreject
		if (folder.value && droppedFolder.id === folder.value.id) return false;
		if (folders.value.some(f => f.id === droppedFolder.id)) return false;
		removeFolder(droppedFolder.id);
		misskeyApi('drive/folders/update', {
			folderId: droppedFolder.id,
			parentId: folder.value ? folder.value.id : null,
		}).then(() => {
			// noop
		}).catch(err => {
			switch (err.code) {
				case 'RECURSIVE_NESTING':
					claimAchievement('driveFolderCircularReference');
					os.alert({
						type: 'error',
						title: i18n.ts.unableToProcess,
						text: i18n.ts.circularReferenceFolder,
					});
					break;
				default:
					os.alert({
						type: 'error',
						text: i18n.ts.somethingHappened,
					});
			}
		});
	}
	//#endregion
}

function urlUpload() {
	os.inputText({
		title: i18n.ts.uploadFromUrl,
		type: 'url',
		placeholder: i18n.ts.uploadFromUrlDescription,
	}).then(({ canceled, result: url }) => {
		if (canceled || !url) return;
		misskeyApi('drive/files/upload-from-url', {
			url: url,
			folderId: folder.value ? folder.value.id : undefined,
		});

		os.alert({
			title: i18n.ts.uploadFromUrlRequested,
			text: i18n.ts.uploadFromUrlMayTakeTime,
		});
	});
}

function createFolder() {
	os.inputText({
		title: i18n.ts.createFolder,
		placeholder: i18n.ts.folderName,
	}).then(({ canceled, result: name }) => {
		if (canceled || name == null) return;
		misskeyApi('drive/folders/create', {
			name: name,
			parentId: folder.value ? folder.value.id : undefined,
		}).then(createdFolder => {
			addFolder(createdFolder, true);
		});
	});
}

function renameFolder(folderToRename: Misskey.entities.DriveFolder) {
	os.inputText({
		title: i18n.ts.renameFolder,
		placeholder: i18n.ts.inputNewFolderName,
		default: folderToRename.name,
	}).then(({ canceled, result: name }) => {
		if (canceled) return;
		misskeyApi('drive/folders/update', {
			folderId: folderToRename.id,
			name: name,
		}).then(updatedFolder => {
			// FIXME: 画面を更新するために自分自身に移動
			move(updatedFolder);
		});
	});
}

function deleteFolder(folderToDelete: Misskey.entities.DriveFolder) {
	misskeyApi('drive/folders/delete', {
		folderId: folderToDelete.id,
	}).then(() => {
		// 削除時に親フォルダに移動
		move(folderToDelete.parentId);
	}).catch(err => {
		switch (err.id) {
			case 'b0fc8a17-963c-405d-bfbc-859a487295e1':
				os.alert({
					type: 'error',
					title: i18n.ts.unableToDelete,
					text: i18n.ts.hasChildFilesOrFolders,
				});
				break;
			default:
				os.alert({
					type: 'error',
					text: i18n.ts.unableToDelete,
				});
		}
	});
}

function upload(file: File, folderToUpload?: Misskey.entities.DriveFolder | null, keepOriginal?: boolean) {
	uploadFile(file, (folderToUpload && typeof folderToUpload === 'object') ? folderToUpload.id : null, undefined, keepOriginal).then(res => {
		addFile(res, true);
	});
}

function chooseFile(file: Misskey.entities.DriveFile) {
	const isAlreadySelected = selectedFiles.value.some(f => f.id === file.id);
	if (props.multiple) {
		if (isAlreadySelected) {
			selectedFiles.value = selectedFiles.value.filter(f => f.id !== file.id);
		} else {
			selectedFiles.value.push(file);
		}
		emit('change-selection', selectedFiles.value);
	} else {
		if (isAlreadySelected) {
			emit('selected', file);
		} else {
			selectedFiles.value = [file];
			emit('change-selection', [file]);
		}
	}
}

function chooseFolder(folderToChoose: Misskey.entities.DriveFolder) {
	const isAlreadySelected = selectedFolders.value.some(f => f.id === folderToChoose.id);
	if (props.multiple) {
		if (isAlreadySelected) {
			selectedFolders.value = selectedFolders.value.filter(f => f.id !== folderToChoose.id);
		} else {
			selectedFolders.value.push(folderToChoose);
		}
		emit('change-selection', selectedFolders.value);
	} else {
		if (isAlreadySelected) {
			emit('selected', folderToChoose);
		} else {
			selectedFolders.value = [folderToChoose];
			emit('change-selection', [folderToChoose]);
		}
	}
}

function unchoseFolder(folderToUnchose: Misskey.entities.DriveFolder) {
	selectedFolders.value = selectedFolders.value.filter(f => f.id !== folderToUnchose.id);
	emit('change-selection', selectedFolders.value);
}

//#region Finder風の選択（ブラウズモード）
type ItemKind = 'file' | 'folder';

function clearSelection() {
	selectedFiles.value = [];
	selectedFolders.value = [];
	selectionAnchor.value = null;
}

// フォルダを先に、ファイルを後に並べた表示順（シフト範囲選択に使う）
function combinedItems(): { kind: ItemKind; id: string }[] {
	return [
		...folders.value.map(f => ({ kind: 'folder' as const, id: f.id })),
		...files.value.map(f => ({ kind: 'file' as const, id: f.id })),
	];
}

function setSelectionByIds(folderIds: Set<string>, fileIds: Set<string>) {
	selectedFolders.value = folders.value.filter(f => folderIds.has(f.id));
	selectedFiles.value = files.value.filter(f => fileIds.has(f.id));
}

function selectRange(anchor: { kind: ItemKind; id: string }, target: { kind: ItemKind; id: string }) {
	const items = combinedItems();
	const ai = items.findIndex(x => x.kind === anchor.kind && x.id === anchor.id);
	const ti = items.findIndex(x => x.kind === target.kind && x.id === target.id);
	if (ai === -1 || ti === -1) return;
	const [lo, hi] = ai < ti ? [ai, ti] : [ti, ai];
	const slice = items.slice(lo, hi + 1);
	setSelectionByIds(
		new Set(slice.filter(x => x.kind === 'folder').map(x => x.id)),
		new Set(slice.filter(x => x.kind === 'file').map(x => x.id)),
	);
}

function browseSelect(kind: ItemKind, item: Misskey.entities.DriveFile | Misskey.entities.DriveFolder, ev: MouseEvent) {
	const ctrl = ev.ctrlKey || ev.metaKey;
	const shift = ev.shiftKey;

	if (shift && selectionAnchor.value) {
		selectRange(selectionAnchor.value, { kind, id: item.id });
		return;
	}

	if (ctrl) {
		if (kind === 'file') {
			const f = item as Misskey.entities.DriveFile;
			selectedFiles.value = selectedFiles.value.some(x => x.id === f.id)
				? selectedFiles.value.filter(x => x.id !== f.id)
				: [...selectedFiles.value, f];
		} else {
			const fo = item as Misskey.entities.DriveFolder;
			selectedFolders.value = selectedFolders.value.some(x => x.id === fo.id)
				? selectedFolders.value.filter(x => x.id !== fo.id)
				: [...selectedFolders.value, fo];
		}
		selectionAnchor.value = { kind, id: item.id };
		return;
	}

	// plain click: select only this item
	if (kind === 'file') {
		selectedFiles.value = [item as Misskey.entities.DriveFile];
		selectedFolders.value = [];
	} else {
		selectedFolders.value = [item as Misskey.entities.DriveFolder];
		selectedFiles.value = [];
	}
	selectionAnchor.value = { kind, id: item.id };
}

function openFile(file: Misskey.entities.DriveFile) {
	router.push(`/my/drive/file/${file.id}`);
}

// 複数選択中のファイルをドラッグした場合、選択中の全ファイルIDをペイロードに載せる
function onFileDragstart(file: Misskey.entities.DriveFile, ev: DragEvent) {
	isDragSource.value = true;
	if (browseMode.value && selectedFiles.value.length > 1 && selectedFiles.value.some(f => f.id === file.id)) {
		ev.dataTransfer?.setData(_DATA_TRANSFER_DRIVE_FILES_, JSON.stringify(selectedFiles.value.map(f => f.id)));
	}
}

async function moveSelection() {
	// フォルダツリーをナビゲートし、OKで現在のフォルダを宛先にする（キャンセル時はno-op）
	const dest = await os.selectDriveFolderToMoveInto();
	const destId = dest[0] ? dest[0].id : null;

	const filesToMove = [...selectedFiles.value];
	const foldersToMove = [...selectedFolders.value];
	clearSelection();

	for (const f of filesToMove) {
		if (f.folderId === destId) continue;
		removeFile(f.id);
		misskeyApi('drive/files/update', { fileId: f.id, folderId: destId });
	}

	for (const fo of foldersToMove) {
		if (fo.id === destId) continue;
		removeFolder(fo.id);
		misskeyApi('drive/folders/update', { folderId: fo.id, parentId: destId }).catch(err => {
			switch (err.code) {
				case 'RECURSIVE_NESTING':
					claimAchievement('driveFolderCircularReference');
					os.alert({
						type: 'error',
						title: i18n.ts.unableToProcess,
						text: i18n.ts.circularReferenceFolder,
					});
					break;
				default:
					os.alert({
						type: 'error',
						text: i18n.ts.somethingHappened,
					});
			}
		});
	}
}

async function downloadSelection() {
	const targets = [...selectedFiles.value];
	if (targets.length === 0) return;

	if (targets.length > 3) {
		os.alert({
			type: 'warning',
			text: i18n.ts.driveDownloadTooMany,
		});
		return;
	}

	const { canceled } = await os.confirm({
		type: 'question',
		text: i18n.tsx.driveFilesDownloadConfirm({ count: targets.length }),
	});
	if (canceled) return;

	for (const file of targets) {
		const a = window.document.createElement('a');
		a.href = file.url;
		a.download = file.name;
		a.target = '_blank';
		window.document.body.appendChild(a);
		a.click();
		a.remove();
	}
}

async function deleteSelection() {
	const count = selectionCount.value;
	if (count === 0) return;

	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx.driveFilesDeleteConfirm({ count }),
	});
	if (canceled) return;

	const filesToDelete = [...selectedFiles.value];
	const foldersToDelete = [...selectedFolders.value];
	clearSelection();

	const results = await Promise.allSettled([
		...filesToDelete.map(f => misskeyApi('drive/files/delete', { fileId: f.id }).then(() => removeFile(f.id))),
		...foldersToDelete.map(fo => misskeyApi('drive/folders/delete', { folderId: fo.id }).then(() => removeFolder(fo.id))),
	]);

	const failed = results.filter(r => r.status === 'rejected').length;
	if (failed > 0) {
		os.alert({
			type: 'error',
			text: i18n.ts.somethingHappened,
		});
	}
}
//#endregion

//#region ラバーバンド（範囲ドラッグ）選択（デスクトップのみ）
let rubberStart: { x: number; y: number } | null = null;
let rubberMoved = false;

function rectsIntersect(a: { left: number; top: number; right: number; bottom: number }, b: DOMRect) {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function onBgMousedown(ev: MouseEvent) {
	if (!browseMode.value || deviceKind !== 'desktop' || ev.button !== 0) return;
	// アイテムや操作要素の上で始まったドラッグは無視（通常の挙動に任せる）
	if ((ev.target as HTMLElement).closest('[data-drive-item], button, a, input, ._button')) return;

	rubberStart = { x: ev.clientX, y: ev.clientY };
	rubberMoved = false;
	rubberband.value = { x: ev.clientX, y: ev.clientY, w: 0, h: 0 };
	window.addEventListener('mousemove', onBgMousemove);
	window.addEventListener('mouseup', onBgMouseup);
	ev.preventDefault();
}

function onBgMousemove(ev: MouseEvent) {
	if (!rubberStart) return;
	const left = Math.min(rubberStart.x, ev.clientX);
	const top = Math.min(rubberStart.y, ev.clientY);
	const right = Math.max(rubberStart.x, ev.clientX);
	const bottom = Math.max(rubberStart.y, ev.clientY);

	if (!rubberMoved && (right - left > 4 || bottom - top > 4)) rubberMoved = true;

	rubberband.value = { x: left, y: top, w: right - left, h: bottom - top };

	if (!rubberMoved) return;

	const selRect = { left, top, right, bottom };
	const folderIds = new Set<string>();
	const fileIds = new Set<string>();
	const els = mainEl.value?.querySelectorAll<HTMLElement>('[data-drive-item]') ?? [];
	for (const el of Array.from(els)) {
		if (!rectsIntersect(selRect, el.getBoundingClientRect())) continue;
		const token = el.dataset.driveItem;
		if (!token) continue;
		const [kind, id] = token.split(':');
		if (kind === 'folder') folderIds.add(id);
		else fileIds.add(id);
	}
	setSelectionByIds(folderIds, fileIds);
	if (folderIds.size + fileIds.size > 0) selectionAnchor.value = null;
}

function onBgMouseup() {
	window.removeEventListener('mousemove', onBgMousemove);
	window.removeEventListener('mouseup', onBgMouseup);
	// 動かさずに背景をクリックしただけなら選択解除（Finder風）
	if (!rubberMoved) clearSelection();
	rubberStart = null;
	rubberband.value = null;
}
//#endregion

function move(target?: Misskey.entities.DriveFolder | Misskey.entities.DriveFolder['id' | 'parentId']) {
	if (!target) {
		goRoot();
		return;
	} else if (typeof target === 'object') {
		target = target.id;
	}

	fetching.value = true;

	misskeyApi('drive/folders/show', {
		folderId: target,
	}).then(folderToMove => {
		folder.value = folderToMove;
		hierarchyFolders.value = [];

		const dive = folderToDive => {
			hierarchyFolders.value.unshift(folderToDive);
			if (folderToDive.parent) dive(folderToDive.parent);
		};

		if (folderToMove.parent) dive(folderToMove.parent);

		emit('open-folder', folderToMove);
		fetch();
	});
}

function addFolder(folderToAdd: Misskey.entities.DriveFolder, unshift = false) {
	const current = folder.value ? folder.value.id : null;
	if (current !== folderToAdd.parentId) return;

	if (folders.value.some(f => f.id === folderToAdd.id)) {
		const exist = folders.value.map(f => f.id).indexOf(folderToAdd.id);
		folders.value[exist] = folderToAdd;
		return;
	}

	if (unshift) {
		folders.value.unshift(folderToAdd);
	} else {
		folders.value.push(folderToAdd);
	}
}

function addFile(fileToAdd: Misskey.entities.DriveFile, unshift = false) {
	const current = folder.value ? folder.value.id : null;
	if (current !== fileToAdd.folderId) return;

	if (files.value.some(f => f.id === fileToAdd.id)) {
		const exist = files.value.map(f => f.id).indexOf(fileToAdd.id);
		files.value[exist] = fileToAdd;
		return;
	}

	if (unshift) {
		files.value.unshift(fileToAdd);
	} else {
		files.value.push(fileToAdd);
	}
}

function removeFolder(folderToRemove: Misskey.entities.DriveFolder | string) {
	const folderIdToRemove = typeof folderToRemove === 'object' ? folderToRemove.id : folderToRemove;
	folders.value = folders.value.filter(f => f.id !== folderIdToRemove);
	// 表示から消えたものは選択からも外す（アクションバーの件数を正しく保つ）
	selectedFolders.value = selectedFolders.value.filter(f => f.id !== folderIdToRemove);
}

function removeFile(file: Misskey.entities.DriveFile | string) {
	const fileId = typeof file === 'object' ? file.id : file;
	files.value = files.value.filter(f => f.id !== fileId);
	selectedFiles.value = selectedFiles.value.filter(f => f.id !== fileId);
}

function appendFile(file: Misskey.entities.DriveFile) {
	addFile(file);
}

function appendFolder(folderToAppend: Misskey.entities.DriveFolder) {
	addFolder(folderToAppend);
}

/*
function prependFile(file: Misskey.entities.DriveFile) {
	addFile(file, true);
}

function prependFolder(folderToPrepend: Misskey.entities.DriveFolder) {
	addFolder(folderToPrepend, true);
}
*/
function goRoot() {
	// 既にrootにいるなら何もしない
	if (folder.value == null) return;

	folder.value = null;
	hierarchyFolders.value = [];
	emit('move-root');
	fetch();
}

async function fetch() {
	folders.value = [];
	files.value = [];
	moreFolders.value = false;
	moreFiles.value = false;
	fetching.value = true;

	const foldersMax = 30;
	const filesMax = 30;

	const foldersPromise = misskeyApi('drive/folders', {
		folderId: folder.value ? folder.value.id : null,
		limit: foldersMax + 1,
		searchQuery: searchQuery.value.toString().trim(),
	}).then(fetchedFolders => {
		if (fetchedFolders.length === foldersMax + 1) {
			moreFolders.value = true;
			fetchedFolders.pop();
		}
		return fetchedFolders;
	});

	const filesPromise = misskeyApi('drive/files', {
		folderId: folder.value ? folder.value.id : null,
		type: props.type,
		limit: filesMax + 1,
		searchQuery: searchQuery.value.toString().trim(),
		sort: sortModeSelect.value,
	}).then(fetchedFiles => {
		if (fetchedFiles.length === filesMax + 1) {
			moreFiles.value = true;
			fetchedFiles.pop();
		}
		return fetchedFiles;
	});

	const [fetchedFolders, fetchedFiles] = await Promise.all([foldersPromise, filesPromise]);

	for (const x of fetchedFolders) appendFolder(x);
	for (const x of fetchedFiles) appendFile(x);

	fetching.value = false;
}

function fetchMoreFolders() {
	fetching.value = true;

	const max = 30;

	misskeyApi('drive/folders', {
		folderId: folder.value ? folder.value.id : null,
		type: props.type,
		untilId: folders.value.at(-1)?.id,
		limit: max + 1,
		searchQuery: searchQuery.value.toString().trim(),
	}).then(folders => {
		if (folders.length === max + 1) {
			moreFolders.value = true;
			folders.pop();
		} else {
			moreFolders.value = false;
		}
		for (const x of folders) appendFolder(x);
		fetching.value = false;
	});
}

function fetchMoreFiles() {
	fetching.value = true;

	const max = 30;

	// ファイル一覧取得
	misskeyApi('drive/files', {
		folderId: folder.value ? folder.value.id : null,
		type: props.type,
		untilId: files.value.at(-1)?.id,
		limit: max + 1,
		searchQuery: searchQuery.value.toString().trim(),
		sort: sortModeSelect.value,
	}).then(files => {
		if (files.length === max + 1) {
			moreFiles.value = true;
			files.pop();
		} else {
			moreFiles.value = false;
		}
		for (const x of files) appendFile(x);
		fetching.value = false;
	});
}

function getMenu() {
	const menu: MenuItem[] = [];

	menu.push({
		text: i18n.ts.addFile,
		type: 'label',
	}, {
		text: i18n.ts.upload + ' (' + i18n.ts.compress + ')',
		icon: 'ti ti-upload',
		action: () => {
			chooseFileFromPc(true, { uploadFolder: folder.value?.id, keepOriginal: false });
		},
	}, {
		text: i18n.ts.upload,
		icon: 'ti ti-upload',
		action: () => {
			chooseFileFromPc(true, { uploadFolder: folder.value?.id, keepOriginal: true });
		},
	}, {
		text: i18n.ts.fromUrl,
		icon: 'ti ti-link',
		action: () => { urlUpload(); },
	}, { type: 'divider' }, {
		text: folder.value ? folder.value.name : i18n.ts.drive,
		type: 'label',
	});

	menu.push({
		type: 'parent',
		text: i18n.ts.sort,
		icon: 'ti ti-arrows-sort',
		children: [{
			text: `${i18n.ts.registeredDate} (${i18n.ts.descendingOrder})`,
			icon: 'ti ti-sort-descending-letters',
			action: () => { sortModeSelect.value = '+createdAt'; },
			active: sortModeSelect.value === '+createdAt',
		}, {
			text: `${i18n.ts.registeredDate} (${i18n.ts.ascendingOrder})`,
			icon: 'ti ti-sort-ascending-letters',
			action: () => { sortModeSelect.value = '-createdAt'; },
			active: sortModeSelect.value === '-createdAt',
		}, {
			text: `${i18n.ts.size} (${i18n.ts.descendingOrder})`,
			icon: 'ti ti-sort-descending-letters',
			action: () => { sortModeSelect.value = '+size'; },
			active: sortModeSelect.value === '+size',
		}, {
			text: `${i18n.ts.size} (${i18n.ts.ascendingOrder})`,
			icon: 'ti ti-sort-ascending-letters',
			action: () => { sortModeSelect.value = '-size'; },
			active: sortModeSelect.value === '-size',
		}, {
			text: `${i18n.ts.name} (${i18n.ts.descendingOrder})`,
			icon: 'ti ti-sort-descending-letters',
			action: () => { sortModeSelect.value = '+name'; },
			active: sortModeSelect.value === '+name',
		}, {
			text: `${i18n.ts.name} (${i18n.ts.ascendingOrder})`,
			icon: 'ti ti-sort-ascending-letters',
			action: () => { sortModeSelect.value = '-name'; },
			active: sortModeSelect.value === '-name',
		}],
	});

	if (folder.value) {
		menu.push({
			text: i18n.ts.renameFolder,
			icon: 'ti ti-forms',
			action: () => { if (folder.value) renameFolder(folder.value); },
		}, {
			text: i18n.ts.deleteFolder,
			icon: 'ti ti-trash',
			action: () => { deleteFolder(folder.value as Misskey.entities.DriveFolder); },
		});
	}

	menu.push({
		text: i18n.ts.createFolder,
		icon: 'ti ti-folder-plus',
		action: () => { createFolder(); },
	});

	return menu;
}

function showMenu(ev: MouseEvent) {
	os.popupMenu(getMenu(), (ev.currentTarget ?? ev.target ?? undefined) as HTMLElement | undefined);
}

function onContextmenu(ev: MouseEvent) {
	os.contextMenu(getMenu(), ev);
}

function closeTip() {
	store.set('readDriveTip', true);
}

onMounted(() => {
	if (prefer.s.enableInfiniteScroll && loadMoreFiles.value) {
		nextTick(() => {
			ilFilesObserver.observe(loadMoreFiles.value?.$el);
		});
	}

	connection.on('fileCreated', onStreamDriveFileCreated);
	connection.on('fileUpdated', onStreamDriveFileUpdated);
	connection.on('fileDeleted', onStreamDriveFileDeleted);
	connection.on('folderCreated', onStreamDriveFolderCreated);
	connection.on('folderUpdated', onStreamDriveFolderUpdated);
	connection.on('folderDeleted', onStreamDriveFolderDeleted);

	if (props.initialFolder) {
		move(props.initialFolder);
	} else {
		fetch();
	}
});

onActivated(() => {
	if (prefer.s.enableInfiniteScroll) {
		nextTick(() => {
			ilFilesObserver.observe(loadMoreFiles.value?.$el);
		});
	}
});

onBeforeUnmount(() => {
	connection.dispose();
	ilFilesObserver.disconnect();
	window.removeEventListener('mousemove', onBgMousemove);
	window.removeEventListener('mouseup', onBgMouseup);
});
</script>

<style lang="scss" module>
.nav {
	display: flex;
	width: 100%;
	padding: 0 8px;
	box-sizing: border-box;
	overflow: auto;
	font-size: 0.9em;
	background: color(from var(--MI_THEME-bg) srgb r g b / 0.75);
	-webkit-backdrop-filter: var(--MI-blur, blur(15px));
	backdrop-filter: var(--MI-blur, blur(15px));
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.selectionBar {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	background: color(from var(--MI_THEME-bg) srgb r g b / 0.85);
	-webkit-backdrop-filter: var(--MI-blur, blur(15px));
	backdrop-filter: var(--MI-blur, blur(15px));
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.selectionCount {
	min-width: 1.6em;
	height: 1.6em;
	padding: 0 0.5em;
	box-sizing: border-box;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 999px;
	background: var(--MI_THEME-accent);
	color: #fff;
	font-weight: bold;
	font-size: 0.9em;
}

.selectionClear {
	margin-left: auto;
	width: 32px;
	height: 32px;
	border-radius: var(--MI-radius-sm);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.rubberband {
	position: fixed;
	z-index: 10000;
	pointer-events: none;
	border: solid 1px var(--MI_THEME-accent);
	background: color(from var(--MI_THEME-accent) srgb r g b / 0.15);
	border-radius: 2px;
}

.navPath {
	display: inline-block;
	vertical-align: bottom;
	line-height: 42px;
	white-space: nowrap;
}

.navPathItem {
	display: inline-block;
	margin: 0;
	padding: 0 8px;
	line-height: 42px;
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}

	&.navCurrent {
		font-weight: bold;
		cursor: default;

		&:hover {
			text-decoration: none;
		}
	}

	&.navSeparator {
		margin: 0;
		padding: 0;
		opacity: 0.5;
		cursor: default;
	}
}

.navMenu {
	display: flex;
	margin-left: auto;
	align-items: center;
}

.navMenu > *:not(:last-child) {
	padding-right: 12px;
}

.main {
	flex: 1;
	overflow: auto;
	padding: var(--MI-margin);
	user-select: none;

	&.fetching {
		cursor: wait !important;
		opacity: 0.5;
		pointer-events: none;
	}

	&.uploading {
		height: calc(100% - 38px - 100px);
	}
}

.folders,
.files {
	display: flex;
	flex-wrap: wrap;
}

.folder,
.file {
	flex-grow: 1;
	width: 128px;
	margin: 4px;
	box-sizing: border-box;
}

.padding {
	flex-grow: 1;
	pointer-events: none;
	width: 128px + 8px;
}

.empty {
	padding: 16px;
	text-align: center;
	pointer-events: none;
	opacity: 0.5;
}

.dropzone {
	position: absolute;
	left: 0;
	top: 38px;
	width: 100%;
	height: calc(100% - 38px);
	border: dashed 2px var(--MI_THEME-focus);
	pointer-events: none;
}
</style>
