<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="!hardMuted && muted === false" v-show="!isDeleted" ref="el" :class="$style.root">
	<!-- gray connector line down the avatar column; hidden on the last member -->
	<div v-if="!isLast" :class="$style.line"></div>
	<div :class="$style.main">
		<div v-if="appearNote.channel" :class="$style.colorBar" :style="{ background: appearNote.channel.color }"></div>
		<MkAvatar :class="$style.avatar" :user="appearNote.user" link preview/>
		<div :class="$style.body">
			<SkNoteHeader :class="$style.header" :note="appearNote" :mini="true"/>
			<div :class="$style.content">
				<p v-if="mergedCW != null" :class="$style.cw">
					<Mfm v-if="mergedCW != ''" style="margin-right: 8px;" :text="mergedCW" :isBlock="true" :author="appearNote.user" :nyaize="'respect'"/>
					<MkCwButton v-model="showContent" :text="appearNote.text" :files="appearNote.files" :poll="appearNote.poll"/>
				</p>
				<div v-show="mergedCW == null || showContent">
					<MkSubNoteContent v-model:showTranslation="showTranslation" :class="$style.text" :note="appearNote" :translating="translating" :translation="translation" :expandAllCws="expandAllCws"/>
				</div>
			</div>
			<MkReactionsViewer ref="reactionsViewer" :note="appearNote"/>
			<footer :class="$style.footer" class="_gaps _h_gaps" tabindex="0" role="group" :aria-label="i18n.ts.noteFooterLabel">
				<button class="_button" :class="$style.noteFooterButton" @click="reply()">
					<i class="ph-arrow-u-up-left ph-bold ph-lg"></i>
					<p v-if="appearNote.repliesCount > 0" :class="$style.noteFooterButtonCount">{{ appearNote.repliesCount }}</p>
				</button>
				<button
					v-if="canRenote"
					ref="renoteButton"
					v-tooltip="renoteTooltip"
					class="_button"
					:class="$style.noteFooterButton"
					:style="renoted ? 'color: var(--MI_THEME-accent) !important;' : ''"
					@click.stop="renoted ? undoRenote() : boostVisibility($event.shiftKey)"
				>
					<i class="ph-rocket-launch ph-bold ph-lg"></i>
					<p v-if="appearNote.renoteCount > 0" :class="$style.noteFooterButtonCount">{{ appearNote.renoteCount }}</p>
				</button>
				<button
					v-if="canRenote && !$i?.rejectQuotes"
					ref="quoteButton"
					class="_button"
					:class="$style.noteFooterButton"
					@click.stop="quote()"
				>
					<i class="ph-quotes ph-bold ph-lg"></i>
				</button>
				<button v-if="appearNote.myReaction == null && appearNote.reactionAcceptance !== 'likeOnly'" ref="likeButton" :class="$style.noteFooterButton" class="_button" @click.stop="like()">
					<i class="ph-heart ph-bold ph-lg"></i>
				</button>
				<button v-if="appearNote.myReaction == null" ref="reactButton" :class="$style.noteFooterButton" class="_button" @click.stop="react()">
					<i v-if="appearNote.reactionAcceptance === 'likeOnly'" class="ph-heart ph-bold ph-lg"></i>
					<i v-else class="ph-smiley ph-bold ph-lg"></i>
				</button>
				<button v-if="appearNote.myReaction != null" ref="reactButton" class="_button" :class="[$style.noteFooterButton, $style.reacted]" @click="undoReact(appearNote)">
					<i class="ph-minus ph-bold ph-lg"></i>
				</button>
				<button v-if="prefer.s.showClipButtonInNoteFooter" ref="clipButton" :class="$style.noteFooterButton" class="_button" @click.stop="clip()">
					<i class="ti ti-paperclip"></i>
				</button>
				<button v-if="prefer.s.showTranslationButtonInNoteFooter && policies.canUseTranslator && instance.translatorAvailable" ref="translationButton" class="_button" :class="$style.noteFooterButton" :style="showTranslation ? 'color: var(--MI_THEME-accent) !important;' : ''" :disabled="translating" @click.stop="translate()">
					<i class="ti ti-language-hiragana"></i>
				</button>
				<button ref="menuButton" class="_button" :class="$style.noteFooterButton" @click.stop="menu()">
					<i class="ph-dots-three ph-bold ph-lg"></i>
				</button>
			</footer>
		</div>
	</div>
</div>
<div v-else-if="!hardMuted && muted !== false" :class="$style.muted" @click="muted = false">
	<SkMutedNote :muted="muted" :note="appearNote"></SkMutedNote>
</div>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { computeMergedCw } from '@@/js/compute-merged-cw.js';
import * as config from '@@/js/config.js';
import type { Ref } from 'vue';
import type { Visibility } from '@/utility/boost-quote.js';
import type { OpenOnRemoteOptions } from '@/utility/please-login.js';
import SkNoteHeader from '@/components/SkNoteHeader.vue';
import MkReactionsViewer from '@/components/MkReactionsViewer.vue';
import MkSubNoteContent from '@/components/MkSubNoteContent.vue';
import MkCwButton from '@/components/MkCwButton.vue';
import * as os from '@/os.js';
import * as sound from '@/utility/sound.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { checkMutes } from '@/utility/check-word-mute.js';
import { pleaseLogin } from '@/utility/please-login.js';
import { showMovedDialog } from '@/utility/show-moved-dialog.js';
import MkRippleEffect from '@/components/MkRippleEffect.vue';
import { reactionPicker } from '@/utility/reaction-picker.js';
import { claimAchievement } from '@/utility/achievements.js';
import { getNoteClipMenu, getNoteMenu, translateNoteWithPrompt, maybeAutoTranslateNote } from '@/utility/get-note-menu.js';
import { boostMenuItems, computeRenoteTooltip } from '@/utility/boost-quote.js';
import { prefer } from '@/preferences.js';
import { useNoteCapture } from '@/use/use-note-capture.js';
import SkMutedNote from '@/components/SkMutedNote.vue';
import { instance, policies } from '@/instance';
import { getAppearNote } from '@/utility/get-appear-note';

const props = withDefaults(defineProps<{
	note: Misskey.entities.Note;
	expandAllCws?: boolean;
	withHardMute?: boolean;
	// the newest member of a thread does not draw a downward connector line
	isLast?: boolean;
}>(), {
	expandAllCws: false,
	withHardMute: false,
	isLast: false,
});

const appearNote = computed(() => getAppearNote(props.note));

const canRenote = computed(() => ['public', 'home'].includes(appearNote.value.visibility) || appearNote.value.userId === $i?.id);

const el = shallowRef<HTMLElement>();
const translation = ref<Misskey.entities.NotesTranslateResponse | false | null>(null);
const translating = ref(false);
const showTranslation = ref(false);
const isDeleted = ref(false);

// Show the translation in-place once it arrives, including when triggered from the note menu.
watch(translation, (value) => {
	if (value != null) showTranslation.value = true;
});

// Auto-translate on load when enabled and the note isn't in the user's language (non-blocking).
onMounted(() => maybeAutoTranslateNote(appearNote.value, translation, translating));
const renoted = ref(false);
const reactButton = shallowRef<HTMLElement>();
const clipButton = useTemplateRef('clipButton');
const renoteButton = shallowRef<HTMLElement>();
const quoteButton = shallowRef<HTMLElement>();
const menuButton = shallowRef<HTMLElement>();
const likeButton = shallowRef<HTMLElement>();

const renoteTooltip = computeRenoteTooltip(renoted);

const defaultLike = computed(() => prefer.s.like ? prefer.s.like : null);

const mergedCW = computed(() => computeMergedCw(appearNote.value));

const pleaseLoginContext = computed<OpenOnRemoteOptions>(() => ({
	type: 'lookup',
	url: appearNote.value.url ?? appearNote.value.uri ?? `${config.url}/notes/${appearNote.value.id}`,
}));

const currentClip = inject<Ref<Misskey.entities.Clip> | null>('currentClip', null);

const { muted, hardMuted } = checkMutes(appearNote.value, props.withHardMute);

useNoteCapture({
	rootEl: el,
	note: appearNote,
	isDeletedRef: isDeleted,
});

if ($i) {
	misskeyApi('notes/renotes', {
		noteId: appearNote.value.id,
		userId: $i.id,
		limit: 1,
	}).then((res) => {
		renoted.value = res.length > 0;
	});
}

function focus() {
	el.value?.focus();
}

async function reply(viaKeyboard = false): Promise<void> {
	pleaseLogin({ openOnRemote: pleaseLoginContext.value });
	showMovedDialog();
	await os.post({
		reply: appearNote.value,
		channel: appearNote.value.channel ?? undefined,
		animation: !viaKeyboard,
	});
	focus();
}

function react(): void {
	pleaseLogin({ openOnRemote: pleaseLoginContext.value });
	showMovedDialog();
	sound.playMisskeySfx('reaction');
	if (appearNote.value.reactionAcceptance === 'likeOnly') {
		misskeyApi('notes/like', {
			noteId: appearNote.value.id,
			override: defaultLike.value,
		});
		const el2 = reactButton.value as HTMLElement | null | undefined;
		if (el2) {
			const rect = el2.getBoundingClientRect();
			const x = rect.left + (el2.offsetWidth / 2);
			const y = rect.top + (el2.offsetHeight / 2);
			const { dispose } = os.popup(MkRippleEffect, { x, y }, {
				end: () => dispose(),
			});
		}
	} else {
		blur();
		reactionPicker.show(reactButton.value ?? null, appearNote.value, reaction => {
			misskeyApi('notes/reactions/create', {
				noteId: appearNote.value.id,
				reaction: reaction,
			});
			if (appearNote.value.text && appearNote.value.text.length > 100 && (Date.now() - new Date(appearNote.value.createdAt).getTime() < 1000 * 3)) {
				claimAchievement('reactWithoutRead');
			}
		}, () => {
			focus();
		});
	}
}

function like(): void {
	pleaseLogin({ openOnRemote: pleaseLoginContext.value });
	showMovedDialog();
	sound.playMisskeySfx('reaction');
	misskeyApi('notes/like', {
		noteId: appearNote.value.id,
		override: defaultLike.value,
	});
	const el2 = likeButton.value as HTMLElement | null | undefined;
	if (el2) {
		const rect = el2.getBoundingClientRect();
		const x = rect.left + (el2.offsetWidth / 2);
		const y = rect.top + (el2.offsetHeight / 2);
		const { dispose } = os.popup(MkRippleEffect, { x, y }, {
			end: () => dispose(),
		});
	}
}

function undoReact(note: Misskey.entities.Note): void {
	const oldReaction = note.myReaction;
	if (!oldReaction) return;
	misskeyApi('notes/reactions/delete', {
		noteId: note.id,
	});
}

function undoRenote(): void {
	if (!renoted.value) return;
	misskeyApi('notes/unrenote', {
		noteId: appearNote.value.id,
	});
	os.toast(i18n.ts.rmboost);
	renoted.value = false;

	const el2 = renoteButton.value as HTMLElement | null | undefined;
	if (el2) {
		const rect = el2.getBoundingClientRect();
		const x = rect.left + (el2.offsetWidth / 2);
		const y = rect.top + (el2.offsetHeight / 2);
		const { dispose } = os.popup(MkRippleEffect, { x, y }, {
			end: () => dispose(),
		});
	}
}

const showContent = ref(prefer.s.uncollapseCW);

watch(() => props.expandAllCws, (expandAllCws) => {
	if (expandAllCws !== showContent.value) showContent.value = expandAllCws;
});

function boostVisibility(forceMenu = false) {
	if (!prefer.s.showVisibilitySelectorOnBoost && !forceMenu) {
		renote(prefer.s.visibilityOnBoost);
	} else {
		os.popupMenu(boostMenuItems(appearNote, renote), renoteButton.value);
	}
}

function renote(visibility: Visibility, localOnly = false) {
	pleaseLogin({ openOnRemote: pleaseLoginContext.value });
	showMovedDialog();

	const el2 = renoteButton.value as HTMLElement | null | undefined;
	if (el2) {
		const rect = el2.getBoundingClientRect();
		const x = rect.left + (el2.offsetWidth / 2);
		const y = rect.top + (el2.offsetHeight / 2);
		const { dispose } = os.popup(MkRippleEffect, { x, y }, {
			end: () => dispose(),
		});
	}

	if (appearNote.value.channel) {
		misskeyApi('notes/create', {
			renoteId: appearNote.value.id,
			channelId: appearNote.value.channelId,
		}).then(() => {
			os.toast(i18n.ts.renoted);
			renoted.value = true;
		});
	} else {
		misskeyApi('notes/create', {
			renoteId: appearNote.value.id,
			localOnly: localOnly,
			visibility: visibility,
		}).then(() => {
			os.toast(i18n.ts.renoted);
			renoted.value = true;
		});
	}
}

function quote() {
	pleaseLogin({ openOnRemote: pleaseLoginContext.value });
	showMovedDialog();

	os.post({
		renote: appearNote.value,
		channel: appearNote.value.channel ?? undefined,
	}).then((cancelled) => {
		if (cancelled) return;
		misskeyApi('notes/renotes', {
			noteId: appearNote.value.id,
			userId: $i?.id,
			limit: 1,
			quote: true,
		}).then((res) => {
			if (!(res.length > 0)) return;
			const popupEl = quoteButton.value as HTMLElement | null | undefined;
			if (popupEl && res.length > 0) {
				const rect = popupEl.getBoundingClientRect();
				const x = rect.left + (popupEl.offsetWidth / 2);
				const y = rect.top + (popupEl.offsetHeight / 2);
				const { dispose } = os.popup(MkRippleEffect, { x, y }, {
					end: () => dispose(),
				});
			}

			os.toast(i18n.ts.quoted);
		});
	});
}

function menu(): void {
	const { menu: m, cleanup } = getNoteMenu({ note: appearNote.value, translating, translation, isDeleted });
	os.popupMenu(m, menuButton.value).then(focus).finally(cleanup);
}

async function clip(): Promise<void> {
	os.popupMenu(await getNoteClipMenu({ note: appearNote.value, isDeleted, currentClip: currentClip?.value }), clipButton.value).then(focus);
}

async function translate() {
	// Already have a translation: just toggle between translated and original text.
	if (translation.value) {
		showTranslation.value = !showTranslation.value;
		return;
	}

	// Fetch (or re-fetch after a previous failure) and reveal the translation in-place.
	showTranslation.value = true;
	translation.value = null;
	await translateNoteWithPrompt(appearNote.value.id, translation, translating);
}
</script>

<style lang="scss" module>
.root {
	padding: 24px 32px;
	position: relative;
}

.line {
	position: absolute;
	left: calc(32px + .5 * var(--MI-avatar));
	border-left: var(--MI-thread-width) solid var(--MI_THEME-thread);
	top: calc(24px + var(--MI-avatar));
	bottom: -24px;
}

.main {
	position: relative;
	display: flex;
}

.colorBar {
	position: absolute;
	top: 8px;
	left: 8px;
	width: 5px;
	height: calc(100% - 8px);
	border-radius: var(--MI-radius-ellipse);
	pointer-events: none;
}

.avatar {
	flex-shrink: 0;
	display: block;
	margin: 0 14px 0 0;
	width: var(--MI-avatar);
	height: var(--MI-avatar);
	border-radius: var(--MI-radius-sm);
	position: relative;
	z-index: 1;
}

.body {
	flex: 1;
	min-width: 0;
}

.header {
	margin-bottom: 2px;
}

.content {
	overflow: hidden;
}

.cw {
	display: block;
	margin: 0;
	padding: 0;
	overflow-wrap: break-word;
}

.text {
	margin: 0;
	padding: 0;
}

.footer {
	display: flex;
	align-items: center;
	justify-content: flex-start;
	position: relative;
	z-index: 1;
	margin-top: 0.4em;
	overflow-x: auto;
}

.noteFooterButton {
	margin: 0;
	padding: 8px;
	padding-top: 10px;
	opacity: 0.7;

	&:hover {
		color: var(--MI_THEME-fgHighlighted);
	}
}

.noteFooterButtonCount {
	display: inline;
	margin: 0 0 0 8px;
	opacity: 0.7;

	&.reacted {
		color: var(--MI_THEME-accent);
	}
}

.muted {
	text-align: center;
	padding: 8px !important;
	border: 1px solid var(--MI_THEME-divider);
	margin: 8px 8px 0 8px;
	border-radius: var(--MI-radius-sm);
	cursor: pointer;

	&:hover {
		background: var(--MI_THEME-buttonBg);
	}
}

@container (max-width: 580px) {
	.root {
		padding: 24px 26px;
		--MI-avatar: 46px;
	}

	.line {
		left: calc(26px + .5 * var(--MI-avatar));
	}
}

@container (max-width: 500px) {
	.root {
		padding: 20px 22px;
	}

	.line {
		top: calc(20px + var(--MI-avatar));
		left: calc(22px + .5 * var(--MI-avatar));
	}
}
</style>
