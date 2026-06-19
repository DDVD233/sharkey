<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModalWindow
	ref="dialog"
	:width="500"
	:height="550"
	data-cy-user-setup
	@close="close(true)"
	@closed="emit('closed')"
>
	<template v-if="page === 0" #header><i class="ti ti-language"></i> {{ i18n.ts._initialAccountSetting.selectLanguage }}</template>
	<template v-else-if="page === 2" #header><i class="ti ti-user-edit"></i> {{ i18n.ts._initialAccountSetting.profileSetting }}</template>
	<template v-else-if="page === 3" #header><i class="ti ti-lock"></i> {{ i18n.ts._initialAccountSetting.privacySetting }}</template>
	<template v-else-if="page === 4" #header><i class="ti ti-user-plus"></i> {{ i18n.ts.follow }}</template>
	<template v-else-if="page === 5" #header><i class="ti ti-bell-plus"></i> {{ i18n.ts.pushNotification }}</template>
	<template v-else-if="page === 6" #header>{{ i18n.ts.done }}</template>
	<template v-else #header>{{ i18n.ts.initialAccountSetting }}</template>

	<div style="overflow-x: clip;">
		<div :class="$style.progressBar">
			<div :class="$style.progressBarValue" :style="{ width: `${(page / 6) * 100}%` }"></div>
		</div>
		<Transition
			mode="out-in"
			:enterActiveClass="$style.transition_x_enterActive"
			:leaveActiveClass="$style.transition_x_leaveActive"
			:enterFromClass="$style.transition_x_enterFrom"
			:leaveToClass="$style.transition_x_leaveTo"
		>
			<template v-if="page === 0">
				<div style="height: 100cqh; overflow: auto;">
					<div :class="$style.pageRoot">
						<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;" :class="$style.pageMain">
							<div class="_gaps">
								<div class="_gaps" style="text-align: center;">
									<i class="ti ti-language" style="display: block; margin: auto; font-size: 3em; color: var(--MI_THEME-accent);"></i>
									<div style="font-size: 120%;">{{ i18n.ts._initialAccountSetting.selectLanguage }}</div>
									<div style="opacity: 0.7; font-size: 90%;">{{ i18n.ts._initialAccountSetting.selectLanguageDescription }}</div>
								</div>
								<div :class="$style.langList">
									<button
										v-for="x in popularLangs"
										:key="x[0]"
										class="_button"
										:class="[$style.langItem, selectedLang === x[0] ? $style.langItemSelected : null]"
										@click="selectedLang = x[0]"
									>
										<span>{{ x[1] }}</span>
										<i v-if="selectedLang === x[0]" class="ti ti-check"></i>
									</button>
									<div :class="$style.langDivider"></div>
									<button
										v-for="x in otherLangs"
										:key="x[0]"
										class="_button"
										:class="[$style.langItem, selectedLang === x[0] ? $style.langItemSelected : null]"
										@click="selectedLang = x[0]"
									>
										<span>{{ x[1] }}</span>
										<i v-if="selectedLang === x[0]" class="ti ti-check"></i>
									</button>
								</div>
							</div>
						</div>
						<div :class="$style.pageFooter">
							<div class="_buttonsCenter">
								<MkButton transparent rounded @click="later(true)">{{ i18n.ts.later }}</MkButton>
								<MkButton primary rounded gradate data-cy-user-setup-continue @click="selectLanguageAndContinue()">{{ i18n.ts.continue }} <i class="ti ti-arrow-right"></i></MkButton>
							</div>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 1">
				<div :class="$style.centerPage">
					<MkAnimBg style="position: absolute; top: 0;" :scale="1.5"/>
					<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
						<div class="_gaps" style="text-align: center;">
							<i class="ti ti-confetti" style="display: block; margin: auto; font-size: 3em; color: var(--MI_THEME-accent);"></i>
							<div style="font-size: 120%;">{{ i18n.ts._initialAccountSetting.accountCreated }}</div>
							<div>{{ i18n.ts._initialAccountSetting.letsStartAccountSetup }}</div>
							<MkButton primary rounded gradate style="margin: 16px auto 0 auto;" data-cy-user-setup-continue @click="page++">{{ i18n.ts._initialAccountSetting.profileSetting }} <i class="ti ti-arrow-right"></i></MkButton>
							<MkButton style="margin: 0 auto;" rounded @click="page--"><i class="ti ti-arrow-left"></i> {{ i18n.ts.goBack }}</MkButton>
							<MkButton style="margin: 0 auto;" transparent rounded @click="later(true)">{{ i18n.ts.later }}</MkButton>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 2">
				<div style="height: 100cqh; overflow: auto;">
					<div :class="$style.pageRoot">
						<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;" :class="$style.pageMain">
							<XProfile/>
						</div>
						<div :class="$style.pageFooter">
							<div class="_buttonsCenter">
								<MkButton rounded data-cy-user-setup-back @click="page--"><i class="ti ti-arrow-left"></i> {{ i18n.ts.goBack }}</MkButton>
								<MkButton primary rounded gradate data-cy-user-setup-continue @click="page++">{{ i18n.ts.continue }} <i class="ti ti-arrow-right"></i></MkButton>
							</div>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 3">
				<div style="height: 100cqh; overflow: auto;">
					<div :class="$style.pageRoot">
						<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;" :class="$style.pageMain">
							<XPrivacy/>
						</div>
						<div :class="$style.pageFooter">
							<div class="_buttonsCenter">
								<MkButton rounded data-cy-user-setup-back @click="page--"><i class="ti ti-arrow-left"></i> {{ i18n.ts.goBack }}</MkButton>
								<MkButton primary rounded gradate data-cy-user-setup-continue @click="page++">{{ i18n.ts.continue }} <i class="ti ti-arrow-right"></i></MkButton>
							</div>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 4">
				<div style="height: 100cqh; overflow: auto;">
					<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
						<XFollow/>
					</div>
					<div :class="$style.pageFooter">
						<div class="_buttonsCenter">
							<MkButton rounded data-cy-user-setup-back @click="page--"><i class="ti ti-arrow-left"></i> {{ i18n.ts.goBack }}</MkButton>
							<MkButton primary rounded gradate style="" data-cy-user-setup-continue @click="page++">{{ i18n.ts.continue }} <i class="ti ti-arrow-right"></i></MkButton>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 5">
				<div :class="$style.centerPage">
					<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
						<div class="_gaps" style="text-align: center;">
							<i class="ti ti-bell-ringing-2" style="display: block; margin: auto; font-size: 3em; color: var(--MI_THEME-accent);"></i>
							<div style="font-size: 120%;">{{ i18n.ts.pushNotification }}</div>
							<div style="padding: 0 16px;">{{ i18n.tsx._initialAccountSetting.pushNotificationDescription({ name: instance.name ?? host }) }}</div>
							<MkPushNotificationAllowButton primary showOnlyToRegister style="margin: 0 auto;"/>
							<div class="_buttonsCenter" style="margin-top: 16px;">
								<MkButton rounded data-cy-user-setup-back @click="page--"><i class="ti ti-arrow-left"></i> {{ i18n.ts.goBack }}</MkButton>
								<MkButton primary rounded gradate data-cy-user-setup-continue @click="page++">{{ i18n.ts.continue }} <i class="ti ti-arrow-right"></i></MkButton>
							</div>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 6">
				<div :class="$style.centerPage">
					<MkAnimBg style="position: absolute; top: 0;" :scale="1.5"/>
					<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
						<div class="_gaps" style="text-align: center;">
							<i class="ti ti-check" style="display: block; margin: auto; font-size: 3em; color: var(--MI_THEME-accent);"></i>
							<div style="font-size: 120%;">{{ i18n.ts._initialAccountSetting.initialAccountSettingCompleted }}</div>
							<div>{{ i18n.tsx._initialAccountSetting.youCanContinueTutorial({ name: instance.name ?? host }) }}</div>
							<div class="_buttonsCenter" style="margin-top: 16px;">
								<MkButton rounded primary gradate data-cy-user-setup-continue @click="launchTutorial()">{{ i18n.ts._initialAccountSetting.startTutorial }} <i class="ti ti-arrow-right"></i></MkButton>
							</div>
							<div class="_buttonsCenter">
								<MkButton rounded data-cy-user-setup-back @click="page--"><i class="ti ti-arrow-left"></i> {{ i18n.ts.goBack }}</MkButton>
								<MkButton rounded primary data-cy-user-setup-continue @click="setupComplete()">{{ i18n.ts.close }}</MkButton>
							</div>
						</div>
					</div>
				</div>
			</template>
		</Transition>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { computed, ref, useTemplateRef, watch, nextTick, defineAsyncComponent } from 'vue';
import { host, lang, langs } from '@@/js/config.js';
import MkModalWindow from '@/components/MkModalWindow.vue';
import MkButton from '@/components/MkButton.vue';
import XProfile from '@/components/MkUserSetupDialog.Profile.vue';
import XFollow from '@/components/MkUserSetupDialog.Follow.vue';
import XPrivacy from '@/components/MkUserSetupDialog.Privacy.vue';
import MkAnimBg from '@/components/MkAnimBg.vue';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import MkPushNotificationAllowButton from '@/components/MkPushNotificationAllowButton.vue';
import { store } from '@/store.js';
import * as os from '@/os.js';
import { prefer } from '@/preferences.js';
import { unisonReload } from '@/utility/unison-reload.js';

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const dialog = useTemplateRef('dialog');

const page = ref(store.s.accountSetupWizard);

watch(page, () => {
	store.set('accountSetupWizard', page.value);
});

// Most popular languages, surfaced first (macOS-style language picker).
const popularLangCodes = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'es-ES'];
const popularLangs = computed(() => popularLangCodes
	.map(code => langs.find(x => x[0] === code))
	.filter((x): x is string[] => x != null));
const otherLangs = computed(() => langs.filter(x => !popularLangCodes.includes(x[0])));

const selectedLang = ref(lang);

function selectLanguageAndContinue() {
	if (selectedLang.value === lang) {
		// No change: continue setup without reloading.
		page.value = 1;
		return;
	}

	// Language changed: persist it and reload so the rest of the setup is
	// rendered in the newly selected language, resuming at the welcome page.
	store.set('accountSetupWizard', 1);
	prefer.suppressReload();
	prefer.commit('lang', selectedLang.value);
	prefer.allowReload();
	unisonReload();
}

async function close(skip: boolean) {
	if (skip) {
		const { canceled } = await os.confirm({
			type: 'warning',
			text: i18n.ts._initialAccountSetting.skipAreYouSure,
		});
		if (canceled) return;
	}

	dialog.value?.close();
	store.set('accountSetupWizard', -1);
}

function setupComplete() {
	store.set('accountSetupWizard', -1);
	dialog.value?.close();
}

function launchTutorial() {
	setupComplete();
	nextTick(() => {
		const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkTutorialDialog.vue')), {
			initialPage: 1,
		}, {
			closed: () => dispose(),
		});
	});
}

async function later(later: boolean) {
	if (later) {
		const { canceled } = await os.confirm({
			type: 'warning',
			text: i18n.ts._initialAccountSetting.laterAreYouSure,
		});
		if (canceled) return;
	}

	dialog.value?.close();
	store.set('accountSetupWizard', 0);
}
</script>

<style lang="scss" module>
.transition_x_enterActive,
.transition_x_leaveActive {
	transition: opacity 0.3s cubic-bezier(0,0,.35,1), transform 0.3s cubic-bezier(0,0,.35,1);
}
.transition_x_enterFrom {
	opacity: 0;
	transform: translateX(50px);
}
.transition_x_leaveTo {
	opacity: 0;
	transform: translateX(-50px);
}

.progressBar {
	position: absolute;
	top: 0;
	left: 0;
	z-index: 10;
	width: 100%;
	height: 4px;
}

.progressBarValue {
	height: 100%;
	background: linear-gradient(90deg, var(--MI_THEME-buttonGradateA), var(--MI_THEME-buttonGradateB));
	transition: all 0.5s cubic-bezier(0,.5,.5,1);
}

.centerPage {
	display: flex;
	justify-content: center;
	align-items: center;
	height: 100cqh;
	padding-bottom: 30px;
	box-sizing: border-box;
}

.pageRoot {
	display: flex;
	flex-direction: column;
	min-height: 100%;
}

.pageMain {
	flex-grow: 1;
}

.langList {
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: var(--MI-radius-sm);
	overflow: hidden;
	background: var(--MI_THEME-panel);
}

.langItem {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	width: 100%;
	padding: 10px 14px;
	text-align: left;
	font-size: 1em;
	line-height: 1.3;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.langItemSelected {
	color: var(--MI_THEME-fgOnAccent);
	background: var(--MI_THEME-accent);

	&:hover {
		background: var(--MI_THEME-accent);
	}
}

.langDivider {
	height: 0.5px;
	margin: 4px 0;
	background: var(--MI_THEME-divider);
}

.pageFooter {
	position: sticky;
	bottom: 0;
	left: 0;
	flex-shrink: 0;
	padding: 12px;
	border-top: solid 0.5px var(--MI_THEME-divider);
	-webkit-backdrop-filter: blur(15px);
	backdrop-filter: blur(15px);
}
</style>
