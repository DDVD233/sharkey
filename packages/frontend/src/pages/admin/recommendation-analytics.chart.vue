<!--
SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_panel" :class="$style.root">
	<div :class="$style.title">{{ title }}</div>
	<canvas ref="chartEl"></canvas>
</div>
</template>

<script lang="ts" setup>
import { onMounted, onBeforeUnmount, watch, useTemplateRef } from 'vue';
import { Chart } from 'chart.js';
import { initChart } from '@/utility/init-chart.js';
import { store } from '@/store.js';

initChart();

const props = defineProps<{
	title: string;
	data: { date: string; value: number }[];
	color?: string;
	percent?: boolean;
}>();

const chartEl = useTemplateRef('chartEl');
let chart: Chart | null = null;

function render(): void {
	if (chartEl.value == null) return;
	if (chart != null) { chart.destroy(); chart = null; }

	const labels = props.data.map(d => d.date.slice(5)); // MM-DD
	const values = props.data.map(d => props.percent ? d.value * 100 : d.value);
	const gridColor = store.s.darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

	chart = new Chart(chartEl.value, {
		type: 'bar',
		data: {
			labels,
			datasets: [{
				data: values,
				backgroundColor: props.color ?? '#86b300',
				borderRadius: 4,
				barPercentage: 0.8,
				categoryPercentage: 0.8,
			}],
		},
		options: {
			aspectRatio: 3,
			plugins: {
				legend: { display: false },
				tooltip: props.percent ? { callbacks: { label: (c) => `${Number(c.parsed.y).toFixed(1)}%` } } : {},
			},
			scales: {
				x: { grid: { display: false } },
				y: { beginAtZero: true, grid: { color: gridColor }, ticks: props.percent ? { callback: (v) => `${v}%` } : {} },
			},
		},
	});
}

onMounted(render);
watch(() => props.data, render, { deep: true });
onBeforeUnmount(() => { if (chart != null) chart.destroy(); });
</script>

<style lang="scss" module>
.root {
	padding: 16px;
}
.title {
	font-weight: bold;
	margin-bottom: 8px;
	opacity: 0.8;
}
</style>
