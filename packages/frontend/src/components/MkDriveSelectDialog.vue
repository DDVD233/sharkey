<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModalWindow
	ref="dialog"
	:width="800"
	:height="500"
	:withOkButton="true"
	:okButtonDisabled="asMoveDestination ? false : ((type === 'file') && (selected.length === 0))"
	@click="cancel()"
	@close="cancel()"
	@ok="ok()"
	@closed="emit('closed')"
>
	<template #header>
		<template v-if="asMoveDestination">{{ i18n.ts.move }}<span style="margin-left: 8px; opacity: 0.5;">{{ currentFolder ? currentFolder.name : i18n.ts.drive }}</span></template>
		<template v-else>
			{{ multiple ? ((type === 'file') ? i18n.ts.selectFiles : i18n.ts.selectFolders) : ((type === 'file') ? i18n.ts.selectFile : i18n.ts.selectFolder) }}
			<span v-if="selected.length > 0" style="margin-left: 8px; opacity: 0.5;">({{ number(selected.length) }})</span>
		</template>
	</template>
	<XDrive v-if="asMoveDestination" :folderDestinationMode="true" @cd="onCd"/>
	<XDrive v-else :multiple="multiple" :select="type" @changeSelection="onChangeSelection" @selected="ok()"/>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { ref, useTemplateRef } from 'vue';
import * as Misskey from 'misskey-js';
import XDrive from '@/components/MkDrive.vue';
import MkModalWindow from '@/components/MkModalWindow.vue';
import number from '@/filters/number.js';
import { i18n } from '@/i18n.js';

const props = withDefaults(defineProps<{
	type?: 'file' | 'folder';
	multiple: boolean;
	// 移動先選択モード：フォルダをナビゲートし、OKで現在のフォルダを宛先として返す
	asMoveDestination?: boolean;
}>(), {
	type: 'file',
	asMoveDestination: false,
});

const emit = defineEmits<{
	(ev: 'done', r?: Misskey.entities.DriveFile[] | Misskey.entities.DriveFolder[]): void;
	(ev: 'closed'): void;
}>();

const dialog = useTemplateRef('dialog');

const selected = ref<Misskey.entities.DriveFile[] | Misskey.entities.DriveFolder[]>([]);
const currentFolder = ref<Misskey.entities.DriveFolder | null>(null);

function ok() {
	if (props.asMoveDestination) {
		// 現在いるフォルダを宛先として返す（ルートなら空配列＝null扱い）
		emit('done', currentFolder.value ? [currentFolder.value] : []);
	} else {
		emit('done', selected.value);
	}
	dialog.value?.close();
}

function cancel() {
	emit('done');
	dialog.value?.close();
}

function onChangeSelection(v: Misskey.entities.DriveFile[] | Misskey.entities.DriveFolder[]) {
	selected.value = v;
}

function onCd(folder: Misskey.entities.DriveFolder | null) {
	currentFolder.value = folder;
}
</script>
