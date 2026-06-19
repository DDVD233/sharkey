<!--
SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkPullToRefresh :refresher="() => reload()">
	<MkNotes ref="notesComponent" :pagination="pagination" :noGap="!prefer.s.showGapBetweenNotesInTimeline"/>
</MkPullToRefresh>
</template>

<script lang="ts" setup>
import { computed, useTemplateRef } from 'vue';
import type { Paging } from '@/components/MkPagination.vue';
import MkNotes from '@/components/MkNotes.vue';
import MkPullToRefresh from '@/components/MkPullToRefresh.vue';
import { miLocalStorage } from '@/local-storage.js';
import { prefer } from '@/preferences.js';

const notesComponent = useTemplateRef('notesComponent');

// The feed is a server-maintained queue rather than an id-ordered list, so we page by offset.
// Most-relevant notes come first; the server backfills popular/recent so the flow never ends.
// `lang` is the user's chosen language (the setup language selector commits to prefer.s.lang),
// falling back to the UI locale — so recommendations are in their language, not the English default.
const pagination: Paging = {
	endpoint: 'notes/recommendations' as const,
	limit: 10,
	offsetMode: true,
	params: computed(() => ({
		lang: (prefer.s.lang ?? miLocalStorage.getItem('lang')) ?? undefined,
		// Only show sensitive content if the user opts to display NSFW by default; otherwise it's
		// down-ranked server-side (it's hidden in the UI anyway and lowers feed quality).
		withSensitive: prefer.s.nsfw === 'ignore',
	})),
};

function reload(): Promise<void> {
	return notesComponent.value?.pagingComponent?.reload() ?? Promise.resolve();
}

defineExpose({ reload });
</script>
