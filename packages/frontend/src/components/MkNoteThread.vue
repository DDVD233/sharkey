<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<!-- truncated preview of the parent that is older than what the timeline loaded -->
	<div v-if="ancestor != null" :class="$style.ancestor">
		<div :class="$style.ancestorLine"></div>
		<MkAvatar :class="$style.ancestorAvatar" :user="ancestor.user" link preview/>
		<MkA :to="notePage(ancestor)" :class="$style.ancestorText"><MkAcct :user="ancestor.user"/>: <Mfm :text="getNoteSummary(ancestor)" :plain="true" :nowrap="true" :author="ancestor.user" :nyaize="'respect'"/></MkA>
	</div>
	<SkNoteThreadItem
		v-for="(member, i) in notes"
		:key="member.id"
		:note="member"
		:isLast="i === notes.length - 1"
		:withHardMute="withHardMute"
		:data-scroll-anchor="member.id"
	/>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'misskey-js';
import SkNoteThreadItem from '@/components/SkNoteThreadItem.vue';
import { getNoteSummary } from '@/utility/get-note-summary.js';
import { notePage } from '@/filters/note.js';

const props = defineProps<{
	// chain members, ordered oldest → newest (top → bottom)
	notes: Misskey.entities.Note[];
	withHardMute?: boolean;
}>();

// The parent of the oldest member, shown as a truncated preview when it is not
// itself part of this merged chain (i.e. it's older than what the timeline loaded).
const ancestor = computed(() => {
	const reply = props.notes[0].reply ?? null;
	if (reply == null) return null;
	if (props.notes.some(n => n.id === reply.id)) return null;
	return reply;
});
</script>

<style lang="scss" module>
// Card chrome (background / radius / outer border) is inherited from the
// surrounding `.note` class applied by the list, so a thread matches both the
// gapped (rounded cards) and noGap (flat list) timeline layouts.
.root {
	position: relative;
}

/* ---- truncated ancestor preview ---- */
.ancestor {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 20px 32px 0;
	position: relative;
	white-space: pre;
}

.ancestorLine {
	position: absolute;
	top: calc(20px + 28px);
	left: calc(32px + .5 * var(--MI-avatar));
	bottom: -8px;
	border-left: var(--MI-thread-width) solid var(--MI_THEME-thread);
}

.ancestorAvatar {
	flex-shrink: 0;
	width: 28px;
	height: 28px;
	margin-left: calc(.5 * var(--MI-avatar) - 14px);
	border-radius: var(--MI-radius-sm);
	position: relative;
	z-index: 1;
}

.ancestorText {
	overflow: hidden;
	flex-shrink: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 90%;
	opacity: 0.7;
	color: inherit;
	text-decoration: none;

	&:hover {
		text-decoration: underline;
	}
}

@container (max-width: 580px) {
	.ancestor {
		padding: 20px 26px 0;
	}

	.ancestorLine {
		left: calc(26px + .5 * var(--MI-avatar));
	}
}

@container (max-width: 500px) {
	.ancestor {
		padding: 16px 22px 0;
	}

	.ancestorLine {
		top: calc(16px + 28px);
		left: calc(22px + .5 * var(--MI-avatar));
	}
}
</style>
