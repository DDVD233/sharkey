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

			<MkFolder defaultOpen>
				<template #label>{{ i18n.ts._recommendation.blockedUsers }}</template>
				<div class="_gaps_s">
					<div>{{ i18n.ts._recommendation.blockedUsersDescription }}</div>
					<MkTextarea v-model="blockedUsers" :spellcheck="false">
						<template #label>{{ i18n.ts._recommendation.blockedUsers }}</template>
						<template #caption>{{ i18n.ts._recommendation.blockedUsersCaption }}</template>
					</MkTextarea>
					<MkButton primary :disabled="busy" @click="saveBlockedUsers">{{ i18n.ts.save }}</MkButton>
					<div>{{ i18n.ts._recommendation.purgeBlockedDescription }}</div>
					<MkButton danger :disabled="busy" @click="purgeBlocked">{{ i18n.ts._recommendation.purgeBlocked }}</MkButton>
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

			<MkFolder>
				<template #label>Learned ranker (heavy ranker)</template>
				<div class="_gaps_s">
					<div>The learned ranker predicts the probability of each engagement type and combines them with the value weights below — <code>score = Σ value · P(engagement)</code> — the same design as Twitter's heavy ranker. Train it offline (<code>scripts/learn-coef.mjs --write</code>), then ramp the blend up from 0. The per-user factor sliders in user settings still apply on top.</div>
					<MkKeyValue>
						<template #key>Trained model</template>
						<template #value>{{ modelLoaded ? ('loaded' + (modelTrainedAt ? ' · ' + modelTrainedAt : '')) : 'none — using the hand-tuned score' }}</template>
					</MkKeyValue>
					<MkRange v-model="rankerWeight" :min="0" :max="1" :step="0.05" :textConverter="(v) => `${Math.round(v * 100)}%`">
						<template #label>Learned blend (λ)</template>
						<template #caption>0 = hand-tuned scoring (default), 1 = pure learned ranker. Intermediate values fuse the two by rank.</template>
					</MkRange>
					<div><b>Engagement value weights</b> — how much each predicted outcome is worth (defaults mirror Twitter's heavy ranker: reply ≫ like, "not interested" strongly negative).</div>
					<MkInput v-for="v in RANKER_VALUE_KEYS" :key="v.key" v-model="engagementValues[v.key]" type="number" :step="0.5">
						<template #label>{{ v.label }}</template>
					</MkInput>
					<MkButton primary :disabled="busy" @click="saveRanker">{{ i18n.ts.save }}</MkButton>
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
import MkRange from '@/components/MkRange.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkTextarea from '@/components/MkTextarea.vue';
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

// Learned ("heavy") ranker config. Value weights default to Twitter's published heavy-ranker weights.
const RANKER_VALUE_KEYS = [
	{ key: 'reaction', label: 'Reaction (like)' },
	{ key: 'favorite', label: 'Favorite (bookmark)' },
	{ key: 'renote', label: 'Renote (boost)' },
	{ key: 'reply', label: 'Reply' },
	{ key: 'dwell', label: 'Dwell / good click' },
	{ key: 'replyEngagedByAuthor', label: 'Reply engaged by author' },
	{ key: 'dislike', label: 'Not interested (negative)' },
] as const;
const DEFAULT_VALUES: Record<string, number> = { reaction: 0.5, favorite: 1, renote: 1, reply: 13.5, dwell: 11, replyEngagedByAuthor: 75, dislike: -74 };
const rankerWeight = ref(0);
const engagementValues = ref<Record<string, number>>({ ...DEFAULT_VALUES });
const modelLoaded = ref(false);
const modelTrainedAt = ref<string | null>(null);

// One acct handle per line (e.g. @alice or @bob@remote.example). Loaded from instance meta.
const blockedUsers = ref('');
misskeyApi('admin/meta').then(meta => {
	blockedUsers.value = (meta.recommendationBlockedUsers ?? []).join('\n');
	rankerWeight.value = meta.recommendationRankerWeight ?? 0;
	const ev = (meta.recommendationEngagementValues ?? {}) as Record<string, number>;
	for (const v of RANKER_VALUE_KEYS) if (typeof ev[v.key] === 'number') engagementValues.value[v.key] = ev[v.key];
	const model = meta.recommendationRankerModel as { trainedAt?: string } | null;
	modelLoaded.value = model != null;
	modelTrainedAt.value = model?.trainedAt ?? null;
});

async function saveRanker(): Promise<void> {
	busy.value = true;
	try {
		await misskeyApi('admin/update-meta', {
			recommendationRankerWeight: rankerWeight.value,
			recommendationEngagementValues: { ...engagementValues.value },
		});
		os.success();
	} finally {
		busy.value = false;
	}
}

async function saveBlockedUsers(): Promise<void> {
	const list = blockedUsers.value.split('\n').map(s => s.trim()).filter(s => s.length > 0);
	busy.value = true;
	try {
		await misskeyApi('admin/update-meta', { recommendationBlockedUsers: list });
		// Reflect the server-side normalization (deduped, leading '@' stripped) back into the textarea.
		const meta = await misskeyApi('admin/meta');
		blockedUsers.value = (meta.recommendationBlockedUsers ?? []).join('\n');
		os.success();
	} finally {
		busy.value = false;
	}
}

async function purgeBlocked(): Promise<void> {
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._recommendation.purgeBlockedConfirm });
	if (canceled) return;
	busy.value = true;
	try {
		const r = await misskeyApi('admin/recommendation/purge-blocked', {});
		await os.alert({
			type: 'success',
			text: i18n.tsx._recommendation.purgeBlockedResult({ users: r.users, notes: r.notesScanned, hq: r.hqRemoved, feat: r.featRemoved }),
		});
	} finally {
		busy.value = false;
	}
}

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
