<!--
SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/settings/recommendations" :label="i18n.ts._recommendations.title" :keywords="['recommendation', 'recommend', 'feed', 'algorithm']" icon="ti ti-sparkles">
	<div class="_gaps_m">
		<MkInfo>{{ i18n.ts._recommendations.about }}</MkInfo>

		<SearchMarker :keywords="['recommendation', 'enable']">
			<MkSwitch v-model="enabled">
				<template #label><SearchLabel>{{ i18n.ts._recommendations.enable }}</SearchLabel></template>
				<template #caption><SearchKeyword>{{ i18n.ts._recommendations.enableCaption }}</SearchKeyword></template>
			</MkSwitch>
		</SearchMarker>

		<MkButton primary rounded full :disabled="saving" @click="save">{{ i18n.ts.save }}</MkButton>

		<MkDisableSection :disabled="!enabled">
			<div class="_gaps_m">
				<!-- Languages -->
				<FormSection>
					<template #label><SearchLabel>{{ i18n.ts._recommendations.languagesHeader }}</SearchLabel></template>
					<template #caption>{{ i18n.ts._recommendations.languagesCaption }}</template>

					<div :class="$style.topicBox">
						<button v-for="l in REC_LANGUAGES" :key="l" class="_button" :class="[$style.chip, languages.includes(l) ? $style.chipInterest : $style.chipAvailable]" @click="toggleLanguage(l)">
							<i :class="[languages.includes(l) ? 'ti ti-check' : 'ti ti-plus', $style.chipIcon]"></i>
							<span>{{ langNames[l] }}</span>
						</button>
					</div>
				</FormSection>

				<!-- Following mix -->
				<FormSection>
					<template #label><SearchLabel>{{ i18n.ts._recommendations.followingHeader }}</SearchLabel></template>
					<template #caption>{{ i18n.ts._recommendations.followingCaption }}</template>

					<div :class="$style.sliderItem">
						<div :class="$style.sliderTitle">
							<span>{{ i18n.ts._recommendations.followingRatio }}</span>
							<span :class="$style.sliderValue">{{ Math.round(followedRatio * 100) }}%</span>
						</div>
						<MkRange v-model="followedRatio" :min="0" :max="1" :step="0.05" :textConverter="toPercent">
							<template #caption>
								<div :class="$style.ticks"><span>0%</span><span>50%</span><span>100%</span></div>
							</template>
						</MkRange>
					</div>
				</FormSection>

				<!-- Ranking-factor coefficients -->
				<FormSection>
					<template #label><SearchLabel>{{ i18n.ts._recommendations.factorsHeader }}</SearchLabel></template>
					<template #caption>{{ i18n.ts._recommendations.factorsCaption }}</template>

					<div class="_gaps_m">
						<div v-for="f in factorDefs" :key="f.key" :class="$style.sliderItem">
							<div :class="$style.sliderTitle">
								<span>{{ f.label }}</span>
								<span :class="$style.sliderValue">×{{ factors[f.key].toFixed(1) }}</span>
							</div>
							<div :class="$style.sliderDesc">{{ f.caption }}</div>
							<MkRange v-model="factors[f.key]" :min="0" :max="2" :step="0.1" :textConverter="toMultiplier">
								<template #label>
									<div :class="$style.ends">
										<span>{{ i18n.ts._recommendations.notImportant }}</span>
										<span>{{ i18n.ts._recommendations.veryImportant }}</span>
									</div>
								</template>
								<template #caption>
									<div :class="$style.ticks"><span>0.0</span><span>1.0</span><span>2.0</span></div>
								</template>
							</MkRange>
						</div>
					</div>
				</FormSection>

				<!-- Interest-vector update weights -->
				<FormSection>
					<template #label><SearchLabel>{{ i18n.ts._recommendations.engagementHeader }}</SearchLabel></template>
					<template #caption>{{ i18n.ts._recommendations.engagementCaption }}</template>

					<div class="_gaps_m">
						<div v-for="e in engagementDefs" :key="e.key" :class="$style.sliderItem">
							<div :class="$style.sliderTitle">
								<span>{{ e.label }}</span>
								<span :class="$style.sliderValue">×{{ engagement[e.key].toFixed(1) }}</span>
							</div>
							<div :class="$style.sliderDesc">{{ e.caption }}</div>
							<MkRange v-model="engagement[e.key]" :min="0" :max="2" :step="0.1" :textConverter="toMultiplier">
								<template #label>
									<div :class="$style.ends">
										<span>{{ i18n.ts._recommendations.notImportant }}</span>
										<span>{{ i18n.ts._recommendations.veryImportant }}</span>
									</div>
								</template>
								<template #caption>
									<div :class="$style.ticks"><span>0.0</span><span>1.0</span><span>2.0</span></div>
								</template>
							</MkRange>
						</div>
					</div>
				</FormSection>

				<!-- NSFW -->
				<FormSection>
					<template #label><SearchLabel>{{ i18n.ts._recommendations.nsfwHeader }}</SearchLabel></template>

					<SearchMarker :keywords="['nsfw', 'sensitive']">
						<MkSwitch v-model="recommendNsfw">
							<template #label><SearchLabel>{{ i18n.ts._recommendations.recommendNsfw }}</SearchLabel></template>
							<template #caption><SearchKeyword>{{ i18n.ts._recommendations.recommendNsfwCaption }}</SearchKeyword></template>
						</MkSwitch>
					</SearchMarker>
				</FormSection>

				<!-- Topics -->
				<FormSection>
					<template #label><SearchLabel>{{ i18n.ts._recommendations.topicsHeader }}</SearchLabel></template>
					<template #caption>{{ i18n.ts._recommendations.topicsCaption }}</template>

					<div class="_gaps_m">
						<div>
							<div :class="$style.topicLabel">{{ i18n.ts._recommendations.interestedTopics }}</div>
							<div :class="$style.topicBox">
								<button v-for="t in interestTopics" :key="t" class="_button" :class="[$style.chip, $style.chipInterest]" @click="removeTopic('interest', t)">
									<span>{{ topicLabel(t) }}</span>
									<i class="ti ti-x" :class="$style.chipIcon"></i>
								</button>
								<button v-for="t in availableTopics" :key="t" class="_button" :class="[$style.chip, $style.chipAvailable]" @click="addTopic('interest', t)">
									<i class="ti ti-plus" :class="$style.chipIcon"></i>
									<span>{{ topicLabel(t) }}</span>
								</button>
							</div>
						</div>
						<div>
							<div :class="$style.topicLabel">{{ i18n.ts._recommendations.notInterestedTopics }}</div>
							<div :class="$style.topicBox">
								<button v-for="t in disinterestTopics" :key="t" class="_button" :class="[$style.chip, $style.chipDisinterest]" @click="removeTopic('disinterest', t)">
									<span>{{ topicLabel(t) }}</span>
									<i class="ti ti-x" :class="$style.chipIcon"></i>
								</button>
								<button v-for="t in availableTopics" :key="t" class="_button" :class="[$style.chip, $style.chipAvailable]" @click="addTopic('disinterest', t)">
									<i class="ti ti-plus" :class="$style.chipIcon"></i>
									<span>{{ topicLabel(t) }}</span>
								</button>
							</div>
						</div>
					</div>
				</FormSection>
			</div>
		</MkDisableSection>

		<MkButton primary rounded full :disabled="saving" @click="save">{{ i18n.ts.save }}</MkButton>
	</div>
</SearchMarker>
</template>

<script lang="ts" setup>
import { ref, reactive, computed, onMounted } from 'vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkRange from '@/components/MkRange.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkDisableSection from '@/components/MkDisableSection.vue';
import FormSection from '@/components/form/section.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { ensureSignin } from '@/i.js';
import { miLocalStorage } from '@/local-storage.js';
import { definePage } from '@/page.js';

const $i = ensureSignin();

// Fixed topic taxonomy — mirrors TOPIC_LABELS in the backend (packages/backend/src/core/rec-topics.ts).
const TOPIC_SLUGS = [
	'anime', 'gaming', 'art', 'sports', 'drawing', 'humor', 'tech', 'home', 'food', 'photography',
	'science', 'study', 'travel', 'music', 'culture', 'emotion', 'career', 'social-science', 'literature',
	'news', 'programming', 'politics', 'pets', 'daily-life',
] as const;
type RecTopic = typeof TOPIC_SLUGS[number];
const isKnownTopic = (t: string): t is RecTopic => (TOPIC_SLUGS as readonly string[]).includes(t);

// Languages the recommender has data for (mirrors REC_LANGUAGES in the backend). Shown by autonym.
const REC_LANGUAGES = ['en', 'ja', 'zh'] as const;
type RecLanguage = typeof REC_LANGUAGES[number];
const langNames: Record<RecLanguage, string> = { en: 'English', ja: '日本語', zh: '中文' };
const isLanguage = (t: string): t is RecLanguage => (REC_LANGUAGES as readonly string[]).includes(t);

// Default the language selection to the user's own UI language when they haven't chosen one yet.
function defaultLang(): RecLanguage {
	const raw = ($i.lang ?? miLocalStorage.getItem('lang') ?? '').toLowerCase();
	if (raw.startsWith('ja')) return 'ja';
	if (raw.startsWith('zh')) return 'zh';
	return 'en';
}

type FactorKey = keyof typeof $i.recommendationSettings.factors;
type EngagementKey = keyof typeof $i.recommendationSettings.engagement;

const cur = $i.recommendationSettings;
const enabled = ref(cur.enabled);
const recommendNsfw = ref(cur.recommendNsfw);
const factors = reactive({ ...cur.factors });
const engagement = reactive({ ...cur.engagement });
const interestTopics = ref<RecTopic[]>([...cur.interestTopics]);
const disinterestTopics = ref<RecTopic[]>([...cur.disinterestTopics]);
const languages = ref<RecLanguage[]>(cur.languages.length > 0 ? [...cur.languages].filter(isLanguage) : [defaultLang()]);
const followedRatio = ref(cur.followedRatio ?? 0.3);
const saving = ref(false);

function toggleLanguage(l: RecLanguage) {
	if (languages.value.includes(l)) {
		if (languages.value.length <= 1) return; // keep at least one language selected
		languages.value = languages.value.filter(x => x !== l);
	} else {
		languages.value = [...languages.value, l];
	}
}

// Pre-fill the topic lists with what the recommender currently believes (auto-derived from the user's
// activity, overlaid with their saved explicit picks). Falls back to the saved values if the read fails.
onMounted(async () => {
	try {
		const res = await misskeyApi('i/recommendation-interests', {});
		interestTopics.value = res.interested.filter(isKnownTopic);
		disinterestTopics.value = res.disinterested.filter(isKnownTopic);
	} catch { /* keep the saved values already loaded above */ }
});

const factorDefs = computed<{ key: FactorKey; label: string; caption: string }[]>(() => [
	{ key: 'relevancy', label: i18n.ts._recommendations._factors.relevancy, caption: i18n.ts._recommendations._factors.relevancyCaption },
	{ key: 'authorAffinity', label: i18n.ts._recommendations._factors.authorAffinity, caption: i18n.ts._recommendations._factors.authorAffinityCaption },
	{ key: 'quality', label: i18n.ts._recommendations._factors.quality, caption: i18n.ts._recommendations._factors.qualityCaption },
	{ key: 'popularity', label: i18n.ts._recommendations._factors.popularity, caption: i18n.ts._recommendations._factors.popularityCaption },
	{ key: 'recency', label: i18n.ts._recommendations._factors.recency, caption: i18n.ts._recommendations._factors.recencyCaption },
	{ key: 'shortPostPenalty', label: i18n.ts._recommendations._factors.shortPostPenalty, caption: i18n.ts._recommendations._factors.shortPostPenaltyCaption },
	{ key: 'overTagPenalty', label: i18n.ts._recommendations._factors.overTagPenalty, caption: i18n.ts._recommendations._factors.overTagPenaltyCaption },
	{ key: 'replyPenalty', label: i18n.ts._recommendations._factors.replyPenalty, caption: i18n.ts._recommendations._factors.replyPenaltyCaption },
	{ key: 'topicPreference', label: i18n.ts._recommendations._factors.topicPreference, caption: i18n.ts._recommendations._factors.topicPreferenceCaption },
	{ key: 'followed', label: i18n.ts._recommendations._factors.followed, caption: i18n.ts._recommendations._factors.followedCaption },
	{ key: 'similarUsers', label: i18n.ts._recommendations._factors.similarUsers, caption: i18n.ts._recommendations._factors.similarUsersCaption },
]);

const engagementDefs = computed<{ key: EngagementKey; label: string; caption: string }[]>(() => [
	{ key: 'reaction', label: i18n.ts._recommendations._engagement.reaction, caption: i18n.ts._recommendations._engagement.reactionCaption },
	{ key: 'reply', label: i18n.ts._recommendations._engagement.reply, caption: i18n.ts._recommendations._engagement.replyCaption },
	{ key: 'boost', label: i18n.ts._recommendations._engagement.boost, caption: i18n.ts._recommendations._engagement.boostCaption },
	{ key: 'favorite', label: i18n.ts._recommendations._engagement.favorite, caption: i18n.ts._recommendations._engagement.favoriteCaption },
	{ key: 'post', label: i18n.ts._recommendations._engagement.post, caption: i18n.ts._recommendations._engagement.postCaption },
]);

// Topics on neither list — offered (as click-to-add tags) in both boxes; keeps the two lists disjoint.
const availableTopics = computed<RecTopic[]>(() => TOPIC_SLUGS.filter(t => !interestTopics.value.includes(t) && !disinterestTopics.value.includes(t)));

function topicLabel(t: RecTopic): string {
	return i18n.ts._recommendations._topics[t];
}

function toMultiplier(v: number): string {
	return '×' + v.toFixed(1);
}

function toPercent(v: number): string {
	return Math.round(v * 100) + '%';
}

function addTopic(which: 'interest' | 'disinterest', t: RecTopic) {
	if (which === 'interest') interestTopics.value = [...interestTopics.value, t];
	else disinterestTopics.value = [...disinterestTopics.value, t];
}

function removeTopic(which: 'interest' | 'disinterest', t: RecTopic) {
	if (which === 'interest') interestTopics.value = interestTopics.value.filter(x => x !== t);
	else disinterestTopics.value = disinterestTopics.value.filter(x => x !== t);
}

async function save() {
	saving.value = true;
	try {
		const i = await os.apiWithDialog('i/update', {
			recommendationSettings: {
				enabled: enabled.value,
				recommendNsfw: recommendNsfw.value,
				factors: { ...factors },
				engagement: { ...engagement },
				interestTopics: [...interestTopics.value],
				disinterestTopics: [...disinterestTopics.value],
				languages: [...languages.value],
				followedRatio: followedRatio.value,
			},
		});
		$i.recommendationSettings = i.recommendationSettings;
	} finally {
		saving.value = false;
	}
}

definePage(() => ({
	title: i18n.ts._recommendations.title,
	icon: 'ti ti-sparkles',
}));
</script>

<style lang="scss" module>
.sliderItem {
	display: flex;
	flex-direction: column;
}

.sliderTitle {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 8px;
	font-size: 0.95em;
	font-weight: 600;
}

.sliderValue {
	font-weight: 500;
	opacity: 0.7;
	font-variant-numeric: tabular-nums;
}

.sliderDesc {
	font-size: 0.85em;
	opacity: 0.75;
	margin: 2px 0 8px;
}

.ends, .ticks {
	display: flex;
	justify-content: space-between;
	padding: 0 10px;
	font-size: 0.8em;
	opacity: 0.7;
}

.ticks {
	font-variant-numeric: tabular-nums;
}

.topicLabel {
	font-size: 0.85em;
	opacity: 0.8;
	margin-bottom: 6px;
}

.topicBox {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	padding: 12px;
	background: var(--MI_THEME-panel);
	border-radius: var(--MI-radius-sm);
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 5px 12px;
	border-radius: 999px;
	font-size: 0.9em;
	line-height: 1;
	border: 1px solid transparent;
}

.chipIcon {
	font-size: 0.9em;
	opacity: 0.8;
}

.chipInterest {
	background: var(--MI_THEME-accentedBg);
	color: var(--MI_THEME-accent);
}

.chipDisinterest {
	background: color(from var(--MI_THEME-error) srgb r g b / 0.15);
	color: var(--MI_THEME-error);
}

.chipAvailable {
	background: transparent;
	border-color: var(--MI_THEME-divider);
	opacity: 0.85;

	&:hover {
		opacity: 1;
		border-color: var(--MI_THEME-accent);
	}
}
</style>
