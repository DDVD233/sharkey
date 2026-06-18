<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<FormSuspense :p="init">
			<div class="_gaps_m">
				<MkInput v-model="translationTimeout" type="number" manualSave @update:modelValue="saveTranslationTimeout">
					<template #label>{{ i18n.ts.translationTimeoutLabel }}</template>
					<template #caption>{{ i18n.ts.translationTimeoutCaption }}</template>
				</MkInput>

				<MkFolder>
					<template #label>DeepL Translation</template>

					<div class="_gaps_m">
						<MkInput v-model="deeplAuthKey">
							<template #prefix><i class="ti ti-key"></i></template>
							<template #label>DeepL Auth Key</template>
						</MkInput>
						<MkSwitch v-model="deeplIsPro">
							<template #label>Pro account</template>
						</MkSwitch>

						<MkSwitch v-model="deeplFreeMode">
							<template #label>{{ i18n.ts.deeplFreeMode }}</template>
						</MkSwitch>
						<MkInput v-if="deeplFreeMode" v-model="deeplFreeInstance" :placeholder="'example.com/translate'">
							<template #prefix><i class="ph-globe-simple ph-bold ph-lg"></i></template>
							<template #label>DeepLX-JS URL</template>
							<template #caption>{{ i18n.ts.deeplFreeModeDescription }}</template>
						</MkInput>

						<MkButton primary @click="save_deepl">Save</MkButton>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>LibreTranslate Translation</template>

					<div class="_gaps_m">
						<MkInput v-model="libreTranslateURL" :placeholder="'example.com/translate'">
							<template #prefix><i class="ph-globe-simple ph-bold ph-lg"></i></template>
							<template #label>LibreTranslate URL</template>
						</MkInput>

						<MkInput v-model="libreTranslateKey">
							<template #prefix><i class="ti ti-key"></i></template>
							<template #label>LibreTranslate Api Key</template>
						</MkInput>

						<MkButton primary @click="save_libre">Save</MkButton>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>LLM server</template>
					<template #caption>One OpenAI-compatible (e.g. vLLM) server shared by LLM translation and the spam filter. Configure it here once and toggle each feature on or off.</template>

					<div class="_gaps_m">
						<MkInput v-model="llmTranslateURL" :placeholder="'https://example.com'">
							<template #prefix><i class="ph-globe-simple ph-bold ph-lg"></i></template>
							<template #label>Endpoint (OpenAI-compatible base URL)</template>
							<template #caption>Base URL of the LLM server. <code>/v1/chat/completions</code> is appended automatically.</template>
						</MkInput>

						<MkInput v-model="llmTranslateKey">
							<template #prefix><i class="ti ti-key"></i></template>
							<template #label>API Key</template>
						</MkInput>

						<MkInput v-model="llmTranslateModel">
							<template #label>Model</template>
							<template #caption>Model name to request from the server.</template>
						</MkInput>

						<MkSwitch v-model="enableLlmTranslation">
							<template #label>Enable translation</template>
							<template #caption>Use this server to translate notes. When on, it is the only translation service (DeepL and LibreTranslate are ignored).</template>
						</MkSwitch>

						<MkSwitch v-model="enableSpamFilter">
							<template #label>Enable spam filter</template>
							<template #caption>Use this server to classify spam/ad/phishing posts (via the local classifier).</template>
						</MkSwitch>

						<MkTextarea v-model="llmTranslatePrompt">
							<template #label>Translation base prompt</template>
							<template #caption>System prompt sent to the model for translation. <code>&#123;&#123;to&#125;&#125;</code> is replaced with the target language. Leave blank to use the built-in default.</template>
						</MkTextarea>

						<MkButton primary @click="save_llm">Save</MkButton>
					</div>
				</MkFolder>
			</div>
		</FormSuspense>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkButton from '@/components/MkButton.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import FormSuspense from '@/components/form/suspense.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { fetchInstance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import MkFolder from '@/components/MkFolder.vue';

// Default LLM translation system prompt. Defined as a JS string (not in the template) so the
// {{to}} placeholder is not parsed as Vue interpolation. Mirrors the backend default
// (notes/translate.ts); {{to}} is replaced with the target language at request time, and the
// note text is appended as a separate user message by the backend.
const DEFAULT_LLM_TRANSLATE_PROMPT = `You are a professional {{to}} native translator specializing in social media posts (fediverse / Mastodon-style). Fluently translate the text into {{to}}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (proper nouns, code, @mentions, #hashtags, URLs), keep the original text.
5. This is casual social-media text. Correctly interpret internet slang, memes, abbreviations, clipped/shortened words and dialect, and render them naturally and idiomatically (e.g. Japanese net slang: 垢=account, 草/w/ｗｗ=lol, ガチ/クソ as intensifiers; clipped forms: ねむ←ねむい=sleepy, おは←おはよう=morning, がんば←がんばる=do my best, り←了解=got it). Translate the intended meaning and preserve the casual tone, not word-for-word.
6. Never leave source-language words untranslated or romanized (do not output romaji/pinyin); always express the meaning in {{to}}. Keep emoticons, kaomoji (e.g. (>_<), orz) and emoji as-is.`;

const translationTimeout = ref(0);
const deeplAuthKey = ref<string | null>('');
const deeplIsPro = ref<boolean>(false);
const deeplFreeMode = ref<boolean>(false);
const deeplFreeInstance = ref<string | null>('');
const libreTranslateURL = ref<string | null>('');
const libreTranslateKey = ref<string | null>('');
const llmTranslateURL = ref<string | null>('');
const llmTranslateKey = ref<string | null>('');
const llmTranslateModel = ref<string | null>('');
const llmTranslatePrompt = ref<string | null>('');
const enableLlmTranslation = ref<boolean>(false);
const enableSpamFilter = ref<boolean>(false);

async function init() {
	const meta = await misskeyApi('admin/meta');
	translationTimeout.value = meta.translationTimeout;
	deeplAuthKey.value = meta.deeplAuthKey;
	deeplIsPro.value = meta.deeplIsPro;
	deeplFreeMode.value = meta.deeplFreeMode;
	deeplFreeInstance.value = meta.deeplFreeInstance;
	libreTranslateURL.value = meta.libreTranslateURL;
	libreTranslateKey.value = meta.libreTranslateKey;
	llmTranslateURL.value = meta.llmTranslateURL;
	llmTranslateKey.value = meta.llmTranslateKey;
	llmTranslateModel.value = meta.llmTranslateModel;
	// Prefill with the default prompt when nothing is saved yet, so it's visible and editable.
	llmTranslatePrompt.value = meta.llmTranslatePrompt ?? DEFAULT_LLM_TRANSLATE_PROMPT;
	enableLlmTranslation.value = meta.enableLlmTranslation;
	enableSpamFilter.value = meta.enableSpamFilter;
}

async function saveTranslationTimeout() {
	await os.apiWithDialog('admin/update-meta', {
		translationTimeout: translationTimeout.value,
	});
	await os.promiseDialog(fetchInstance(true));
}

function save_deepl() {
	os.apiWithDialog('admin/update-meta', {
		deeplAuthKey: deeplAuthKey.value,
		deeplIsPro: deeplIsPro.value,
		deeplFreeMode: deeplFreeMode.value,
		deeplFreeInstance: deeplFreeInstance.value,
	}).then(() => {
		os.promiseDialog(fetchInstance(true));
	});
}

function save_libre() {
	os.apiWithDialog('admin/update-meta', {
		libreTranslateURL: libreTranslateURL.value,
		libreTranslateKey: libreTranslateKey.value,
	}).then(() => {
		os.promiseDialog(fetchInstance(true));
	});
}

function save_llm() {
	os.apiWithDialog('admin/update-meta', {
		llmTranslateURL: llmTranslateURL.value,
		llmTranslateKey: llmTranslateKey.value,
		llmTranslateModel: llmTranslateModel.value,
		llmTranslatePrompt: llmTranslatePrompt.value,
		enableLlmTranslation: enableLlmTranslation.value,
		enableSpamFilter: enableSpamFilter.value,
	}).then(() => {
		os.promiseDialog(fetchInstance(true));
	});
}

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.externalServices,
	icon: 'ph-arrow-square-out ph-bold ph-lg',
}));
</script>
