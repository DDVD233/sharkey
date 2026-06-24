<!--
SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModalWindow ref="dialogEl" :width="560" @close="dialogEl?.close()" @closed="emit('closed')">
	<template #header>{{ i18n.ts._recommendations.whyRecommended }}</template>
	<template #default>
		<div class="_spacer">
			<div class="_gaps_m">
				<div :class="$style.summary">
					<MkKeyValue>
						<template #key>{{ i18n.ts._recommendations._reason.finalScore }}</template>
						<template #value><b>{{ breakdown.score.toFixed(3) }}</b></template>
					</MkKeyValue>
					<MkKeyValue v-if="breakdown.topic">
						<template #key>{{ i18n.ts._recommendations._reason.inferredTopic }}</template>
						<template #value>{{ topicLabel(breakdown.topic) }}</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ i18n.ts._recommendations._reason.recommendationType }}</template>
						<template #value>{{ breakdown.type === 'following' ? i18n.ts._recommendations._reason.typeFollowing : i18n.ts._recommendations._reason.typeScore }}</template>
					</MkKeyValue>
				</div>

				<!-- Followed posts are scored just like discovery (so they rank); the type above marks them. -->
				<div v-if="breakdown.type === 'following'" :class="$style.followingNote">
					{{ i18n.ts._recommendations._reason.followingCaption }}
				</div>

				<div :class="$style.tableWrap">
					<table :class="$style.table">
						<thead>
							<tr>
								<th>{{ i18n.ts._recommendations._reason.factor }}</th>
								<th>{{ i18n.ts._recommendations._reason.rawScore }}</th>
								<th>{{ i18n.ts._recommendations._reason.baseFactor }}</th>
								<th>{{ i18n.ts._recommendations._reason.yourCoefficient }}</th>
								<th>{{ i18n.ts._recommendations._reason.effect }}</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="row in additiveRows" :key="row.key" :class="{ [$style.muted]: row.coeff === 0 }">
								<td>{{ i18n.ts._recommendations._factors[row.key] }}</td>
								<td>{{ row.raw.toFixed(2) }}</td>
								<td>×{{ row.weight.toFixed(2) }}</td>
								<td>×{{ row.coeff.toFixed(1) }}</td>
								<td>{{ effectLabel(row) }}</td>
							</tr>
						</tbody>
						<tfoot>
							<tr>
								<td colspan="4">{{ i18n.ts._recommendations._reason.subtotal }}</td>
								<td>{{ breakdown.subtotal.toFixed(3) }}</td>
							</tr>
							<!-- Multiplicative factors (recency) apply to the subtotal, so they sit below it and above the final score. -->
							<tr v-for="row in multRows" :key="row.key" :class="$style.multRow">
								<td>{{ i18n.ts._recommendations._factors[row.key] }}</td>
								<td>{{ row.raw.toFixed(2) }}</td>
								<td>—</td>
								<td>×{{ row.coeff.toFixed(1) }}</td>
								<td>{{ effectLabel(row) }}</td>
							</tr>
							<tr :class="$style.totalRow">
								<td colspan="4">{{ i18n.ts._recommendations._reason.finalScore }}</td>
								<td>{{ breakdown.score.toFixed(3) }}</td>
							</tr>
						</tfoot>
					</table>
				</div>

				<!-- Learned ("heavy") ranker contribution, shown when a model drove part of the ranking. -->
				<div v-if="breakdown.engagements && breakdown.engagements.length > 0" :class="$style.tableWrap">
					<div :class="$style.learnedHead">Learned ranker · {{ Math.round((breakdown.rankerWeight ?? 0) * 100) }}% blend · score {{ (breakdown.learnedScore ?? 0).toFixed(2) }}</div>
					<table :class="$style.table">
						<thead>
							<tr>
								<th>Predicted engagement</th>
								<th>Probability</th>
								<th>Value</th>
								<th>Contribution</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="row in breakdown.engagements" :key="row.key">
								<td>{{ engagementLabel(row.key) }}</td>
								<td>{{ (row.prob * 100).toFixed(1) }}%</td>
								<td>{{ row.value.toFixed(1) }}</td>
								<td>{{ (row.effect >= 0 ? '+' : '') + row.effect.toFixed(2) }}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>
	</template>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { computed, useTemplateRef } from 'vue';
import type { RecommendationBreakdown } from '@/utility/recommendation-reason.js';
import MkModalWindow from '@/components/MkModalWindow.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import { i18n } from '@/i18n.js';

const props = defineProps<{
	breakdown: RecommendationBreakdown;
}>();

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const dialogEl = useTemplateRef('dialogEl');

// Additive factors sum to the subtotal (shown in the table body); multiplicative factors (recency)
// apply to that subtotal, so they're rendered in the footer between the subtotal and the final score.
const additiveRows = computed(() => props.breakdown.rows.filter(r => r.kind === 'add'));
const multRows = computed(() => props.breakdown.rows.filter(r => r.kind === 'mult'));

// The note's inferred topic slug → its localized name.
function topicLabel(slug: string): string {
	const topics = i18n.ts._recommendations._topics as Record<string, string>;
	return topics[slug] ?? slug;
}

// Additive factors show a signed contribution (+/−); the recency factor shows its multiplier (×).
function effectLabel(row: { kind: 'add' | 'mult'; effect: number }): string {
	if (row.kind === 'mult') return '×' + row.effect.toFixed(2);
	return (row.effect >= 0 ? '+' : '') + row.effect.toFixed(3);
}

// Predicted-engagement keys → human labels for the learned-ranker table.
const ENGAGEMENT_LABELS: Record<string, string> = {
	reaction: 'Reaction', favorite: 'Favorite', renote: 'Renote', reply: 'Reply',
	dwell: 'Good click', replyEngagedByAuthor: 'Reply engaged by author', dislike: 'Not interested',
};
function engagementLabel(key: string): string {
	return ENGAGEMENT_LABELS[key] ?? key;
}
</script>

<style lang="scss" module>
.summary {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 24px;
}

.tableWrap {
	overflow-x: auto;
}

.table {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.9em;

	th, td {
		padding: 6px 8px;
		text-align: right;
		white-space: nowrap;
		border-bottom: 1px solid var(--MI_THEME-divider);
	}

	th:first-child, td:first-child {
		text-align: left;
	}

	thead th {
		font-weight: bold;
		opacity: 0.8;
	}

	tfoot .totalRow td {
		font-weight: bold;
		border-bottom: none;
		border-top: 2px solid var(--MI_THEME-divider);
	}
}

.learnedHead {
	margin-bottom: 6px;
	font-weight: bold;
	opacity: 0.8;
}

.muted {
	opacity: 0.45;
}

.multRow td {
	font-style: italic;
	border-top: 1px dashed var(--MI_THEME-divider);
	border-bottom: 1px dashed var(--MI_THEME-divider);
}

.followingNote {
	padding: 12px 14px;
	border-radius: 8px;
	background: var(--MI_THEME-buttonBg);
	color: var(--MI_THEME-fg);
	font-size: 0.95em;
	line-height: 1.5;
}
</style>
