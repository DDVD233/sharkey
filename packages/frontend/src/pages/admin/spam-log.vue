<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions">
	<div class="_spacer" style="--MI_SPACER-w: 900px;">
		<div class="_gaps">
			<MkInfo>Posts automatically hidden by the spam filter. Restoring makes a post public again and removes it from this list.</MkInfo>

			<div :class="$style.bar">
				<div>{{ count }} moderated post(s)</div>
				<MkButton small rounded @click="reload"><i class="ti ti-refresh"></i> Reload</MkButton>
			</div>

			<MkLoading v-if="fetching"/>

			<div v-else-if="items.length === 0" class="_fullinfo">
				<div>No moderated posts.</div>
			</div>

			<template v-else>
				<div v-for="item in items" :key="item.id" class="_panel" :class="$style.item">
					<div :class="$style.itemHeader">
						<span :class="[$style.label, $style['label_' + item.label]]">{{ item.label }} {{ item.score.toFixed(2) }}</span>
						<span :class="$style.handle">@{{ item.username }}{{ item.userHost ? '@' + item.userHost : '' }}</span>
						<span :class="$style.date"><MkTime :time="item.createdAt"/></span>
						<span v-if="item.visibility && item.visibility !== 'public'" :class="$style.vis">now: {{ item.visibility }}</span>
					</div>
					<div v-if="item.cw" :class="$style.cw">CW: {{ item.cw }}</div>
					<div :class="$style.text">{{ item.noteExists ? (item.text ?? '(no text)') : '(note deleted)' }}</div>
					<div :class="$style.itemFooter">
						<MkA v-if="item.noteExists" :to="`/notes/${item.noteId}`" class="_link">Open post</MkA>
						<MkButton small danger rounded @click="restore(item)">Restore to public &amp; remove</MkButton>
					</div>
				</div>

				<div :class="$style.pager">
					<MkButton :disabled="page <= 0" small rounded @click="goto(page - 1)"><i class="ti ti-chevron-left"></i></MkButton>
					<span>Page {{ page + 1 }} / {{ totalPages }}</span>
					<MkButton :disabled="page >= totalPages - 1" small rounded @click="goto(page + 1)"><i class="ti ti-chevron-right"></i></MkButton>
					<MkInput v-model="jumpTo" type="number" :min="1" :max="totalPages" style="width: 90px; margin: 0;"/>
					<MkButton small rounded @click="goto(Number(jumpTo) - 1)">Go</MkButton>
				</div>
			</template>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';

type SpamLogItem = {
	id: string;
	createdAt: string;
	label: string;
	score: number;
	reason: string | null;
	noteId: string | null;
	noteExists: boolean;
	visibility: string | null;
	text: string | null;
	cw: string | null;
	userId: string;
	username: string | null;
	userHost: string | null;
};

const LIMIT = 20;
const items = ref<SpamLogItem[]>([]);
const count = ref(0);
const page = ref(0);
const jumpTo = ref(1);
const fetching = ref(true);

const totalPages = computed(() => Math.max(1, Math.ceil(count.value / LIMIT)));

async function load() {
	fetching.value = true;
	const res = await misskeyApi('admin/spam-log/list' as any, { limit: LIMIT, page: page.value }) as { count: number; items: SpamLogItem[] };
	count.value = res.count;
	items.value = res.items;
	jumpTo.value = page.value + 1;
	fetching.value = false;
}

function goto(p: number) {
	const target = Math.min(totalPages.value - 1, Math.max(0, isNaN(p) ? 0 : p));
	page.value = target;
	load();
}

function reload() {
	load();
}

async function restore(item: SpamLogItem) {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: `Restore this post to public and remove it from the moderated list?`,
	});
	if (canceled) return;
	await os.apiWithDialog('admin/spam-log/restore' as any, { id: item.id });
	// If we removed the last item on a page, step back a page when needed.
	if (items.value.length === 1 && page.value > 0) {
		page.value -= 1;
	}
	await load();
}

load();

const headerActions = computed(() => [{
	icon: 'ti ti-refresh',
	text: i18n.ts.reload,
	handler: reload,
}]);

definePage(() => ({
	title: 'Moderated posts',
	icon: 'ti ti-shield',
}));
</script>

<style lang="scss" module>
.bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--MI-margin);
}
.item {
	padding: 16px;
}
.itemHeader {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	font-size: 0.9em;
	margin-bottom: 6px;
}
.label {
	font-weight: bold;
	padding: 2px 6px;
	border-radius: 6px;
	background: var(--MI_THEME-accentedBg);
	color: var(--MI_THEME-accent);
}
.label_phishing, .label_spam {
	background: rgba(255, 0, 0, 0.1);
	color: #d40000;
}
.handle {
	opacity: 0.8;
}
.date {
	margin-left: auto;
	opacity: 0.7;
}
.vis {
	opacity: 0.7;
}
.cw {
	opacity: 0.8;
	margin-bottom: 4px;
}
.text {
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 8em;
	overflow: auto;
}
.itemFooter {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--MI-margin);
	margin-top: 10px;
}
.pager {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 10px;
	flex-wrap: wrap;
}
</style>
