<!--
SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 800px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<div class="_gaps">
			<MkInfo>{{ i18n.ts._recommendation.about }}</MkInfo>

			<MkFolder>
				<template #label>{{ i18n.ts._recommendation.initVectors }}</template>
				<div class="_gaps_s">
					<div>{{ i18n.ts._recommendation.initVectorsDescription }}</div>
					<MkButton primary :disabled="busy" @click="initVectors">{{ i18n.ts._recommendation.initVectors }}</MkButton>
				</div>
			</MkFolder>

			<MkFolder>
				<template #label>{{ i18n.ts._recommendation.rebuildVectors }}</template>
				<div class="_gaps_s">
					<div>{{ i18n.ts._recommendation.rebuildVectorsDescription }}</div>
					<MkButton :disabled="busy" @click="rebuildVectors">{{ i18n.ts._recommendation.rebuildVectors }}</MkButton>
				</div>
			</MkFolder>

			<MkFolder>
				<template #label>{{ i18n.ts._recommendation.prefill }}</template>
				<div class="_gaps_s">
					<div>{{ i18n.ts._recommendation.prefillDescription }}</div>
					<MkInput v-model="prefillDays" type="number" :min="1" :max="365"><template #label>{{ i18n.ts._recommendation.prefillDays }}</template></MkInput>
					<MkInput v-model="prefillLangs"><template #label>{{ i18n.ts._recommendation.prefillLangs }}</template><template #caption>e.g. zh,en,ja</template></MkInput>
					<MkSwitch v-model="prefillImagesOnly">{{ i18n.ts._recommendation.prefillImagesOnly }}</MkSwitch>
					<MkButton :disabled="busy" @click="prefill">{{ i18n.ts._recommendation.prefill }}</MkButton>
				</div>
			</MkFolder>

			<MkFolder>
				<template #label>Backfill quality scores</template>
				<div class="_gaps_s">
					<div>Score content quality (structural + LLM interestingness) for recent public notes that don't have it yet. Skips already-scored notes.</div>
					<MkInput v-model="qualityDays" type="number" :min="1" :max="365"><template #label>Days</template></MkInput>
					<MkInput v-model="qualityLangs"><template #label>Languages</template><template #caption>e.g. zh,en,ja</template></MkInput>
					<MkButton :disabled="busy" @click="backfillQuality">Backfill quality</MkButton>
				</div>
			</MkFolder>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInput from '@/components/MkInput.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

const busy = ref(false);
const prefillDays = ref(30);
const prefillLangs = ref('zh');
const prefillImagesOnly = ref(false);
const qualityDays = ref(60);
const qualityLangs = ref('zh');

async function run(action: () => Promise<unknown>): Promise<void> {
	const { canceled } = await os.confirm({ type: 'question', text: i18n.ts.areYouSure });
	if (canceled) return;
	busy.value = true;
	try {
		await action();
		os.success();
	} finally {
		busy.value = false;
	}
}

function initVectors(): Promise<void> {
	return run(() => misskeyApi('admin/recommendation/backfill-history', {}));
}

function rebuildVectors(): Promise<void> {
	return run(() => misskeyApi('admin/recommendation/rebuild-user-vectors', {}));
}

function prefill(): Promise<void> {
	const langs = prefillLangs.value.split(',').map(s => s.trim()).filter(s => s.length > 0);
	return run(() => misskeyApi('admin/recommendation/prefill', { days: prefillDays.value, langs: langs.length > 0 ? langs : undefined, imagesOnly: prefillImagesOnly.value }));
}

function backfillQuality(): Promise<void> {
	const langs = qualityLangs.value.split(',').map(s => s.trim()).filter(s => s.length > 0);
	return run(() => misskeyApi('admin/recommendation/backfill-quality', { days: qualityDays.value, langs: langs.length > 0 ? langs : undefined }));
}

const headerActions = computed(() => []);
const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.recommendations,
	icon: 'ti ti-sparkles',
}));
</script>
