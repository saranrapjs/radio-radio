import "babel-polyfill";
import { Interval, DateTime, Info } from "luxon";
import { LZMA } from "lzma/src/lzma_worker.js";
import html from "choo/html";
import choo from "choo";

function base64ToByteArray(base64) {
	let raw = window.atob(base64);
	let rawLength = raw.length;
	let array = new Uint8Array(new ArrayBuffer(rawLength));
	for (let i = 0; i < rawLength; i++) {
		array[i] = raw.charCodeAt(i);
	}
	return array;
}

function stringToZip(string) {
	return new Promise((resolve, reject) => {
		LZMA.compress(string, 9, function(result, error) {
			if (error) return reject(error);
			let base64String = btoa(
				String.fromCharCode.apply(null, new Uint8Array(result))
			);
			resolve(base64String);
		});
	});
}

function zipToString(data) {
	return new Promise((resolve, reject) => {
		let array = base64ToByteArray(data);
		LZMA.decompress(array, function(result, error) {
			if (!(typeof result === "string")) result = new Uint8Array(result);
			if (error) return reject(error);
			resolve(result);
		});
	});
}

let config = [
	// {
	// 	url: "http://wkcr.streamguys1.com/live",
	// 	time: ["22:00", "PT1H21M"]
	// },
	// {
	// 	url: "http://188.165.192.5:8242/kzschigh",
	// 	time: ["22:00", "PT1H22M"]
	// }
];

function updateConfig(val) {
	config = val;
	refreshConfigPromise();
	stringToZip(JSON.stringify(config)).then(base64 => {
		history.pushState(null, null, `#${base64}`);
	});
	window.config = config;
}

window.updateConfig = updateConfig;

window.stringToZip = stringToZip;
window.zipToString = zipToString;

let configUpdated;
let updateConfigPromise;
function refreshConfigPromise() {
	if (configUpdated) configUpdated();
	updateConfigPromise = new Promise(resolve => {
		configUpdated = resolve;
	});
}
refreshConfigPromise();

const wait = num =>
	new Promise(resolve => {
		setTimeout(resolve, num);
	});

const toInterval = timeCfg => {
	let start = DateTime.fromISO(timeCfg[0]);
	if (timeCfg.length > 2) {
		start = start.set({ weekday: timeCfg[2] });
	}
	return Interval.fromISO(`${start.toISO()}/${timeCfg[1]}`);
};

const renderText = ({ url, interval, time }) => {
	let prefix = "every day";
	if (time.length > 2) {
		prefix = `${interval.start.weekdayLong}s`;
	}
	return `${prefix} from ${interval.start.toLocaleString(
		DateTime.TIME_SIMPLE
	)} to ${interval.end.toLocaleString(DateTime.TIME_SIMPLE)} ${url}`;
};

async function seek(emit) {
	const now = DateTime.local();
	const sortedConfig = config.sort((a, b) => a.time.length - b.time.length);
	for (let i = 0; i < sortedConfig.length; i++) {
		const { time, url } = sortedConfig[i];
		const interval = toInterval(time);
		if (time.length > 2 && time[2] !== now.weekday) {
			continue;
		}
		if (interval.contains(now)) {
			emit("play", sortedConfig[i]);
			const { milliseconds } = interval.end.diff(now).toObject();
			await wait(milliseconds);
			emit("play", false);
			seek(emit);
			return;
		}
	}
	await Promise.race([wait(60 * 1000), updateConfigPromise]);
	seek(emit);
}

const app = choo();

function mainView(state, emit) {
	return html`
	<body>
		${config.length
			? html`<div>
			<h1>${state.show ? renderText(state.show) : ""}</h1>
			<audio src=${state.show ? state.show.url : ""}></audio>
			${state.show
				? html`<button onclick=${onplay}>${state.playing
						? "pause"
						: "play"}</button>`
				: ""}
			<h2>on deck:</h2>
			<ul id="deck">${config
				.map(show =>
					Object.assign(
						{
							interval: toInterval(show.time)
						},
						show
					)
				)
				.map(
					show =>
						html`<li>${renderText(
							show
						)} <a href="javascript://" data-url=${show.url} onclick=${ondelete}>🗑</a></li>`
				)}</ul>
		</div>`
			: ""}
		<hr>
		<form onsubmit=${onadd}>
			url: <input name="url" type="text" class="url-input">
			day: <select name="day" class="day">${state.days.map(
				({ label, value }) =>
					html`<option value=${value}>${label}</option>`
			)}</select>
			start: <input name="start" type="time" class="start">
			end: <input name="end" type="time" class="end">
			<button id="add">add</button>
		</form>
	</body>
  `;
	function onplay(e) {
		e.preventDefault();
		emit("toggle");
	}
	function ondelete(e) {
		emit("delete", e.target.dataset.url);
	}
	function onadd(e) {
		e.preventDefault();
		const { url, day, start, end } = e.target.elements;
		emit("new", {
			url: url.value,
			day: day.value,
			start: start.value,
			end: end.value
		});
	}
}

function store(state, emitter) {
	state.url = false;
	state.playing = false;
	state.days = [];
	for (let i = 0; i <= 7; i++) {
		state.days.push({
			label: Info.weekdays()[i - 1] || "every day",
			value: i
		});
	}
	emitter.on("play", show => {
		if (show) {
			const interval = toInterval(show.time);
			state.show = { ...show, interval };
		} else {
			state.show = false;
		}
		setTimeout(() => emitter.emit("toggle", !!state.show));
	});
	emitter.on("toggle", playPause => {
		const player = document.querySelector("audio");
		let play = player && player.paused ? true : false;
		if (playPause !== undefined) {
			play = playPause;
		}
		let promise;
		if (play && player) {
			promise = player.play();
		} else if (player) {
			player.pause();
			promise = Promise.resolve();
		}
		if (promise) {
			promise.then(() => {
				state.playing = play;
				emitter.emit("render");
			});
		}
	});
	emitter.on("new", ({ url, start, end, day }) => {
		const startTime = DateTime.fromISO(start).setZone("utc");
		const endTime = DateTime.fromISO(end).setZone("utc");
		let diff = endTime.diff(startTime);
		// if this is a negative diff, assume it crosses the day boundary?
		if (diff < 0) {
			diff = endTime.plus({ days: 1 }).diff(startTime);
		}
		const time = [startTime.toISOTime(), diff.toISO()];
		if (day !== "0") {
			time.push(parseInt(day, 10));
		}
		const cfg = {
			url: url,
			time
		};
		if (cfg.url && cfg.url.length && cfg.time.length) {
			config.push(cfg);
			updateConfig(config);
			emitter.emit("render");
		}
	});
	emitter.on("delete", url => {
		const newConfig = config.filter(show => show.url !== url);
		updateConfig(newConfig);
		emitter.emit("render");
	});
	seek(emitter.emit.bind(emitter));

	if (window.location.hash.length > 1) {
		zipToString(window.location.hash.substring(1)).then(data => {
			updateConfig(JSON.parse(data));
			emitter.emit("render");
		});
	}
}

app.use(store);
app.route("*", mainView);
app.mount("body");
