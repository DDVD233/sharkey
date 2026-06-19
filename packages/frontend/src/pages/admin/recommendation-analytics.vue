<!--
SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 1000px;">
		<MkLoading v-if="fetching"/>
		<div v-else-if="data" class="_gaps">
			<div :class="$style.boxes">
				<div class="_panel" :class="$style.box">
					<div :class="$style.boxValue"><MkNumber :value="data.totalRecommended"/></div>
					<div :class="$style.boxLabel">{{ i18n.ts._recommendation.totalRecommended }}</div>
				</div>
				<div class="_panel" :class="$style.box">
					<div :class="$style.boxValue"><MkNumber :value="data.totalUsers"/></div>
					<div :class="$style.boxLabel">{{ i18n.ts._recommendation.totalUsers }}</div>
				</div>
			</div>

			<XChart :title="i18n.ts._recommendation.recommendedPerDay" :data="data.daily.map(d => ({ date: d.date, value: d.recommended }))" color="#86b300"/>
			<XChart :title="i18n.ts._recommendation.activeUsersPerDay" :data="data.daily.map(d => ({ date: d.date, value: d.activeUsers }))" color="#3498db"/>
			<XChart :title="i18n.ts._recommendation.reactionRatePerDay" :data="data.daily.map(d => ({ date: d.date, value: d.reactionRate }))" color="#e67e22" percent/>

			<div class="_panel" :class="$style.tableWrap">
				<div :class="$style.title">{{ i18n.ts._recommendation.usersTable }}</div>
				<table :class="$style.table">
					<thead>
						<tr>
							<th :class="$style.th" @click="setSort('username')">{{ i18n.ts.username }}<span v-if="sortKey === 'username'">{{ sortAsc ? ' ▲' : ' ▼' }}</span></th>
							<th :class="[$style.th, $style.num]" @click="setSort('viewed')">{{ i18n.ts._recommendation.viewed }}<span v-if="sortKey === 'viewed'">{{ sortAsc ? ' ▲' : ' ▼' }}</span></th>
							<th :class="[$style.th, $style.num]" @click="setSort('recentViewed')">{{ i18n.ts._recommendation.recentViewed }}<span v-if="sortKey === 'recentViewed'">{{ sortAsc ? ' ▲' : ' ▼' }}</span></th>
							<th :class="[$style.th, $style.num]" @click="setSort('likeRate')">{{ i18n.ts._recommendation.likeRate }}<span v-if="sortKey === 'likeRate'">{{ sortAsc ? ' ▲' : ' ▼' }}</span></th>
							<th :class="[$style.th, $style.num]" @click="setSort('recentLikeRate')">{{ i18n.ts._recommendation.recentLikeRate }}<span v-if="sortKey === 'recentLikeRate'">{{ sortAsc ? ' ▲' : ' ▼' }}</span></th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="u in sortedUsers" :key="u.userId">
							<td><MkA :class="$style.userLink" :to="`/@${u.username}`">@{{ u.username }}</MkA></td>
							<td :class="$style.num">{{ number(u.viewed) }}</td>
							<td :class="$style.num">{{ number(u.recentViewed) }}</td>
							<td :class="$style.num">{{ (u.likeRate * 100).toFixed(1) }}%</td>
							<td :class="$style.num">{{ (u.recentLikeRate * 100).toFixed(1) }}%</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import XChart from './recommendation-analytics.chart.vue';
import MkNumber from '@/components/MkNumber.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import number from '@/filters/number.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

type Stats = {
	totalRecommended: number;
	totalUsers: number;
	daily: { date: string; recommended: number; activeUsers: number; reactionRate: number }[];
	users: { userId: string; username: string; viewed: number; recentViewed: number; likeRate: number; recentLikeRate: number }[];
};

const fetching = ref(true);
const data = ref<Stats | null>(null);

type SortKey = 'username' | 'viewed' | 'recentViewed' | 'likeRate' | 'recentLikeRate';
const sortKey = ref<SortKey>('viewed');
const sortAsc = ref(false);

const sortedUsers = computed(() => {
	if (data.value == null) return [];
	const rows = [...data.value.users];
	rows.sort((a, b) => {
		const av = a[sortKey.value];
		const bv = b[sortKey.value];
		const cmp = av < bv ? -1 : av > bv ? 1 : 0;
		return sortAsc.value ? cmp : -cmp;
	});
	return rows;
});

function setSort(key: SortKey): void {
	if (sortKey.value === key) {
		sortAsc.value = !sortAsc.value;
	} else {
		sortKey.value = key;
		// numbers default to descending (biggest first), text to ascending.
		sortAsc.value = key === 'username';
	}
}

onMounted(async () => {
	data.value = await misskeyApi('admin/recommendation/stats', { days: 30 }) as Stats;
	fetching.value = false;
});

const headerActions = computed(() => []);
const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts._recommendation.analytics,
	icon: 'ti ti-chart-bar',
}));
</script>

<style lang="scss" module>
.boxes {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
	gap: 12px;
}
.box {
	padding: 16px;
}
.boxValue {
	font-size: 1.8em;
	font-weight: bold;
}
.boxLabel {
	font-size: 0.85em;
	opacity: 0.7;
}
.tableWrap {
	padding: 16px;
	overflow-x: auto;
}
.title {
	font-weight: bold;
	margin-bottom: 8px;
	opacity: 0.8;
}
.table {
	width: 100%;
	border-collapse: collapse;
}
.th {
	text-align: left;
	cursor: pointer;
	user-select: none;
	padding: 6px 10px;
	border-bottom: solid 1px var(--MI_THEME-divider);
	white-space: nowrap;
}
.table td {
	padding: 6px 10px;
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}
.num {
	text-align: right;
	font-variant-numeric: tabular-nums;
}
.userLink {
	color: var(--MI_THEME-link);
}
.userLink:hover {
	text-decoration: underline;
}
</style>
