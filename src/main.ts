import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
	throw new Error("Could not find the application root");
}

app.innerHTML = `
	<main class="application">
		<section class="viewport">
			<p>Texture viewport</p>
		</section>

		<aside class="sidebar">
			<h1>NavigateVR Map Calibrator</h1>

			<label>
				Texture
				<input id="texture-input" type="file" accept=".dds">
			</label>

			<label>
				Point name
				<input id="point-name" type="text">
			</label>

			<label>
				X coordinate
				<input id="point-x" type="number" step="1">
			</label>

			<label>
				Y coordinate
				<input id="point-y" type="number" step="1">
			</label>
		</aside>
	</main>
`;