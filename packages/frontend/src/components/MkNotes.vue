<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkPagination ref="pagingComponent" :pagination="pagination" :disableAutoLoad="disableAutoLoad" :displayLimit="displayLimit">
	<template #empty>
		<div class="_fullinfo">
			<img :src="infoImageUrl" draggable="false"/>
			<div>{{ i18n.ts.noNotes }}</div>
		</div>
	</template>

	<template #default="{ items: notes }">
		<div :class="[$style.root, { [$style.noGap]: noGap, '_gaps': !noGap, [$style.reverse]: pagination.reversed }]">
			<template v-for="unit in groupNoteThreads(notes as Misskey.entities.Note[], prefer.s.mergeThreadsInTimeline)" :key="unit.id">
				<MkNoteThread v-if="unit.type === 'thread'" :class="$style.note" :notes="unit.notes" :withHardMute="true" :data-scroll-anchor="unit.id"/>
				<DynamicNote v-else :class="$style.note" :note="unit.note" :withHardMute="true" :data-scroll-anchor="unit.id"/>
				<MkAd v-if="unit.note._shouldInsertAd_" :preferForms="['horizontal', 'horizontal-big']" :class="$style.ad"/>
			</template>
		</div>
	</template>
</MkPagination>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import { useTemplateRef } from 'vue';
import type { Paging } from '@/components/MkPagination.vue';
import DynamicNote from '@/components/DynamicNote.vue';
import MkNoteThread from '@/components/MkNoteThread.vue';
import MkPagination from '@/components/MkPagination.vue';
import { i18n } from '@/i18n.js';
import { infoImageUrl } from '@/instance.js';
import { prefer } from '@/preferences.js';
import { groupNoteThreads } from '@/utility/group-note-threads.js';

withDefaults(defineProps<{
	pagination: Paging;
	noGap?: boolean;
	disableAutoLoad?: boolean;
	displayLimit?: number;
}>(), {
	displayLimit: 200,
});

const pagingComponent = useTemplateRef('pagingComponent');

defineExpose({
	pagingComponent,
});
</script>

<style lang="scss" module>
.reverse {
	display: flex;
	flex-direction: column-reverse;
}

.root {
	container-type: inline-size;

	&.noGap {
		background: color-mix(in srgb, var(--MI_THEME-panel) 65%, transparent);

		.note:not(:empty) {
			border-bottom: solid 0.5px var(--MI_THEME-divider);
		}

		.ad {
			padding: 8px;
			background-size: auto auto;
			background-image: repeating-linear-gradient(45deg, transparent, transparent 8px, var(--MI_THEME-bg) 8px, var(--MI_THEME-bg) 14px);
			border-bottom: solid 0.5px var(--MI_THEME-divider);
		}
	}

	&:not(.noGap) {
		background: var(--MI_THEME-bg);

		.note {
			background: color-mix(in srgb, var(--MI_THEME-panel) 65%, transparent);
			border-radius: var(--MI-radius);
		}
	}
}

.ad:empty {
	display: none;
}
</style>
