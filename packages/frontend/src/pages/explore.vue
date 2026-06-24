<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader v-model:tab="tab" :actions="headerActions" :tabs="headerTabs" :swipable="true">
	<div v-if="tab === 'recommendations'">
		<XRecommendations ref="recommendationsEl"/>
	</div>
	<div v-else-if="tab === 'featured'">
		<XFeatured/>
	</div>
	<div v-else-if="tab === 'users'">
		<XUsers/>
	</div>
	<div v-else-if="tab === 'roles'">
		<XRoles/>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, watch, ref, useTemplateRef } from 'vue';
import XRecommendations from './explore.recommendations.vue';
import XFeatured from './explore.featured.vue';
import XUsers from './explore.users.vue';
import XRoles from './explore.roles.vue';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';

const props = withDefaults(defineProps<{
	tag?: string;
	initialTab?: string;
}>(), {
	initialTab: 'recommendations',
});

// Recommendations can be switched off per-user; when off, hide the tab and don't default to it.
const recommendationsEnabled = computed(() => $i?.recommendationSettings?.enabled !== false);

const tab = ref(props.initialTab === 'recommendations' && !recommendationsEnabled.value ? 'featured' : props.initialTab);
const tagsEl = useTemplateRef('tagsEl');
const recommendationsEl = useTemplateRef('recommendationsEl');

watch(() => props.tag, () => {
	if (tagsEl.value) tagsEl.value.toggleContent(props.tag == null);
});

const headerActions = computed(() => []);

const headerTabs = computed(() => [...(recommendationsEnabled.value ? [{
	key: 'recommendations',
	icon: 'ti ti-sparkles',
	title: i18n.ts.recommendations,
	// Clicking the tab scrolls to top (default); also refresh the feed so it re-ranks with newest content.
	onClick: () => { recommendationsEl.value?.reload(); },
}] : []), {
	key: 'featured',
	icon: 'ti ti-bolt',
	title: i18n.ts.featured,
}, {
	key: 'users',
	icon: 'ti ti-users',
	title: i18n.ts.users,
}, {
	key: 'roles',
	icon: 'ti ti-badges',
	title: i18n.ts.roles,
}]);

definePage(() => ({
	title: i18n.ts.explore,
	icon: 'ti ti-hash',
}));
</script>
