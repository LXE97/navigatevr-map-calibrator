import "./style.css";
import { decodeDds } from "./dds";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
    throw new Error("Could not find the application root");
}

app.innerHTML = `
	<main class="application">
		<aside class="json-sidebar">
			<h2>JSON Output</h2>
			<button id="download-json" type="button">Download JSON</button>
			<pre id="json-output">{}</pre>
			source: <a
				class="source-repository"
				href="https://github.com/LXE97/navigatevr-map-calibrator"
				target="_blank"
				rel="noopener noreferrer"
			>LXE97/navigatevr-map-calibrator</a>
		</aside>

		<section class="viewport">
			<canvas id="texture-canvas"></canvas>
			<div id="points-overlay" aria-hidden="true"></div>
		</section>

		<aside class="sidebar">
			<h1>NavigateVR Map Calibrator</h1>
            <section class="instructions-section">
            <h2>Instructions</h2><br>
            <ul>
            <li>Left-click: pan</li>
            <li>Mousewheel: zoom</li>
            <li>Right-click to add or drag points.</li>
            <li>Enter the Skyrim World coordinates for each point.</li>
            <li>Select 3 points to use for calibration.</li>
            <li>Test points will be displayed in green when calibration is performed</li>
            <li>Left/Right map data will be merged into the same JSON object</li>

            <li>Check console (F12) for errors</li>
            </ul>
            </section>

			<label class="texture-picker">
				Texture
				<input id="texture-input" type="file" accept=".dds,.png,image/png">
			</label>

			<button id="calibrate-button" type="button">Calibrate</button>

            <fieldset class="metadata-section">
                <legend>Metadata</legend>
                <Label>Map Name (for JSON label)</label>
                <input id="mapname" value="Skyrim"><br>  
                <label class="left-hand-map">
                    <input type="checkbox" id="isLeft">
                    Left Hand Map
                </label>
                <Label>Map Item FormID</label>
                <input id="ItemFormID" value="0x000000"><br>
                <Label>Map Plugin Name</label>
                <input id="ItemPlugin" value="Navigate VR - Equipable Dynamic Compass and Maps.esp"><br>
                <Label>Worldspace FormID</label>
                <input id="WorldspaceID" value ="0x000000"><br>
                <Label>Worldspace Plugin Name</label>
                <input id="WorldspacePlugin" value="Skyrim.esm"><br>
            </fieldset>

			<section class="testpoint-section">
				<div class="section-heading">
					<h2>Test Points</h2>
					<button id="add-test-point" type="button">Add Test Point</button>
				</div>
				<div id="test-points-list"></div>
			</section>

			<section class="points-section">
				<h2>Calibration Points</h2>
				<div id="points-list"></div>
			</section>
		</aside>
	</main>
`;

interface PointData {
    textureX: number;
    textureY: number;
    worldX: number | null;
    worldY: number | null;
}

interface TestPointData {
    worldX: number | null;
    worldY: number | null;
}

type Coordinate = readonly [number, number];
type AffineMatrix = [
    [number, number, number],
    [number, number, number],
];

interface CalibrationEntry {
    ItemPlugin: string;
    LeftItemFormID?: string[];
    RightItemFormID?: string[];
    WorldspacePlugin: string;
    WorldspaceID: string;
    CalibrationLeft?: AffineMatrix;
    CalibrationRight?: AffineMatrix;
}

const textureInput =
    document.querySelector<HTMLInputElement>("#texture-input");

const textureCanvas =
    document.querySelector<HTMLCanvasElement>("#texture-canvas");

const viewport =
    document.querySelector<HTMLElement>(".viewport");

const pointsList =
    document.querySelector<HTMLDivElement>("#points-list");

const pointsOverlay =
    document.querySelector<HTMLDivElement>("#points-overlay");

const calibrateButton =
    document.querySelector<HTMLButtonElement>("#calibrate-button");

const addTestPointButton =
    document.querySelector<HTMLButtonElement>("#add-test-point");

const testPointsList =
    document.querySelector<HTMLDivElement>("#test-points-list");

const jsonOutput =
    document.querySelector<HTMLPreElement>("#json-output");

const downloadJsonButton =
    document.querySelector<HTMLButtonElement>("#download-json");

const mapNameInput =
    document.querySelector<HTMLInputElement>("#mapname");

const itemPluginInput =
    document.querySelector<HTMLInputElement>("#ItemPlugin");

const itemFormIdInput =
    document.querySelector<HTMLInputElement>("#ItemFormID");

const worldspacePluginInput =
    document.querySelector<HTMLInputElement>("#WorldspacePlugin");

const worldspaceIdInput =
    document.querySelector<HTMLInputElement>("#WorldspaceID");

const isLeftInput =
    document.querySelector<HTMLInputElement>("#isLeft");

if (
    !textureInput ||
    !textureCanvas ||
    !viewport ||
    !pointsList ||
    !pointsOverlay ||
    !calibrateButton ||
    !addTestPointButton ||
    !testPointsList ||
    !jsonOutput ||
    !downloadJsonButton ||
    !mapNameInput ||
    !itemPluginInput ||
    !itemFormIdInput ||
    !worldspacePluginInput ||
    !worldspaceIdInput ||
    !isLeftInput
) {
    throw new Error("Could not initialize the texture loader");
}

downloadJsonButton.addEventListener("click", () => {
    const mapName = mapNameInput!.value.trim() || "map";
    const blob = new Blob([jsonOutput!.textContent ?? "{}"], {
        type: "application/json",
    });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = `${mapName}.json`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
});

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 1;
const POINT_HIT_RADIUS = 20;
const points: PointData[] = [];
const checkedPoints = new Set<PointData>();
const testPoints: TestPointData[] = [{ worldX: null, worldY: null }];
const calibrationJson: Record<string, CalibrationEntry> = {};
let zoom = 1;
let panX = 0;
let panY = 0;
let hasTexture = false;
let dragPointerId: number | null = null;
let draggedPointIndex: number | null = null;
let suppressPointCreation = false;
let previousPointerX = 0;
let previousPointerY = 0;
let tamrielR: AffineMatrix | null = null;

function addCalibrationToJson(matrix: AffineMatrix): boolean {
    const mapName = mapNameInput!.value.trim();
    if (!mapName) {
        console.error("A map name is required.");
        return false;
    }

    const existing = calibrationJson[mapName];
    const selectedCalibration = isLeftInput!.checked
        ? existing?.CalibrationLeft
        : existing?.CalibrationRight;
    if (
        selectedCalibration &&
        !window.confirm(
            `${mapName} already has calibration data for the ` +
            `${isLeftInput!.checked ? "left" : "right"} side. Replace it?`,
        )
    ) {
        return false;
    }

    const entry: CalibrationEntry = existing ?? {
        ItemPlugin: "",
        WorldspacePlugin: "",
        WorldspaceID: "",
    };
    const itemFormIds = itemFormIdInput!.value
        .split(",")
        .map((formId) => formId.trim())
        .filter(Boolean);

    entry.ItemPlugin = itemPluginInput!.value.trim();
    entry.WorldspacePlugin = worldspacePluginInput!.value.trim();
    entry.WorldspaceID = worldspaceIdInput!.value.trim();

    if (isLeftInput!.checked) {
        entry.LeftItemFormID = itemFormIds;
        entry.CalibrationLeft = matrix;
    } else {
        entry.RightItemFormID = itemFormIds;
        entry.CalibrationRight = matrix;
    }

    calibrationJson[mapName] = entry;
    jsonOutput!.textContent = JSON.stringify(calibrationJson, null, 4);
    return true;
}

function getAffineMatrix(
    game: readonly [Coordinate, Coordinate, Coordinate],
    map: readonly [Coordinate, Coordinate, Coordinate],
): AffineMatrix | null {
    const [[x1, y1], [x2, y2], [x3, y3]] = game;
    const determinant =
        x1 * (y2 - y3) +
        x2 * (y3 - y1) +
        x3 * (y1 - y2);

    if (determinant === 0) {
        return null;
    }

    const solve = (z1: number, z2: number, z3: number) => [
        (
            z1 * (y2 - y3) +
            z2 * (y3 - y1) +
            z3 * (y1 - y2)
        ) / determinant,
        (
            z1 * (x3 - x2) +
            z2 * (x1 - x3) +
            z3 * (x2 - x1)
        ) / determinant,
        (
            z1 * (x2 * y3 - x3 * y2) +
            z2 * (x3 * y1 - x1 * y3) +
            z3 * (x1 * y2 - x2 * y1)
        ) / determinant,
    ] as [number, number, number];

    return [
        solve(map[0][0], map[1][0], map[2][0]),
        solve(map[0][1], map[1][1], map[2][1]),
    ];
}

function calibrate(): AffineMatrix | null {
    const selectedPoints = points.filter((point) => checkedPoints.has(point));

    if (selectedPoints.length !== 3) {
        console.error("Calibration requires exactly three selected points.");
        return null;
    }

    if (textureCanvas!.width !== textureCanvas!.height) {
        console.error("Calibration requires a square texture.");
        return null;
    }

    if (selectedPoints.some(
        (point) => point.worldX === null || point.worldY === null,
    )) {
        console.error("All selected points require world coordinates.");
        return null;
    }

    const textureSize = textureCanvas!.width;
    const game = selectedPoints.map(
        (point) => [point.worldX!, point.worldY!] as Coordinate,
    ) as [Coordinate, Coordinate, Coordinate];
    const map = selectedPoints.map(
        (point) => [
            point.textureX / textureSize,
            point.textureY / textureSize,
        ] as Coordinate,
    ) as [Coordinate, Coordinate, Coordinate];

    tamrielR = getAffineMatrix(game, map);
    if (!tamrielR) {
        console.error("Calibration points must not be collinear.");
        return null;
    }

    if (!addCalibrationToJson(tamrielR)) {
        return null;
    }

    renderPointMarkers();
    console.log("TamrielR:", tamrielR);
    return tamrielR;
}

calibrateButton.addEventListener("click", calibrate);

function numberFromInput(input: HTMLInputElement): number | null {
    if (input.value === "") {
        return null;
    }

    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
}

function sanitizeNumericInput(value: string): string {
    const stripped = value.replace(/[^\d.+-]/g, "");
    const sign = stripped.startsWith("-")
        ? "-"
        : stripped.startsWith("+") ? "+" : "";
    const unsigned = stripped.replace(/[+-]/g, "");
    const decimalIndex = unsigned.indexOf(".");

    if (decimalIndex === -1) {
        return sign + unsigned;
    }

    return sign +
        unsigned.slice(0, decimalIndex + 1) +
        unsigned.slice(decimalIndex + 1).replace(/\./g, "");
}

function createPointInput(
    labelText: string,
    value: string,
    onInput: (input: HTMLInputElement) => void,
    sanitize = false,
): HTMLLabelElement {
    const label = document.createElement("label");
    const labelName = document.createElement("span");
    const input = document.createElement("input");

    labelName.textContent = labelText;
    input.type = sanitize ? "text" : "number";
    if (sanitize) {
        input.inputMode = "decimal";
    }
    input.value = value;
    input.step = "any";
    input.addEventListener("input", () => {
        if (sanitize) {
            input.value = sanitizeNumericInput(input.value);
        }
        onInput(input);
    });
    label.append(labelName, input);
    return label;
}

function createCoordinateInputPair(
    firstInput: HTMLLabelElement,
    secondInput: HTMLLabelElement,
    className = "",
): HTMLDivElement {
    const coordinateInputs = document.createElement("div");

    coordinateInputs.className = [
        "coordinate-inputs",
        className,
    ].filter(Boolean).join(" ");
    coordinateInputs.append(firstInput, secondInput);
    return coordinateInputs;
}

function createTextureCoordinateInputs(
    point: PointData,
    pointIndex: number,
): HTMLDivElement {
    const createTextureInput = (
        label: string,
        value: number,
        updatePoint: (value: number) => void,
    ): HTMLLabelElement => {
        const inputLabel = createPointInput(
            label,
            Math.round(value).toString(),
            (input) => {
                const inputValue = numberFromInput(input);
                if (inputValue !== null) {
                    updatePoint(Math.round(inputValue));
                    renderPointMarkers();
                }
            },
        );
        const input = inputLabel.querySelector("input")!;

        input.step = "1";
        input.addEventListener("change", () => {
            const inputValue = numberFromInput(input);
            if (inputValue !== null) {
                input.value = Math.round(inputValue).toString();
            }
        });
        return inputLabel;
    };
    const coordinateInputs = createCoordinateInputPair(
        createTextureInput(
            "Texture X",
            point.textureX,
            (value) => { point.textureX = value; },
        ),
        createTextureInput(
            "Texture Y",
            point.textureY,
            (value) => { point.textureY = value; },
        ),
        "texture-coordinate-inputs",
    );

    coordinateInputs.dataset.pointIndex = pointIndex.toString();
    return coordinateInputs;
}

function updateTextureCoordinateInputs(pointIndex: number): void {
    const coordinateInputs = pointsList!.querySelector<HTMLElement>(
        `.texture-coordinate-inputs[data-point-index="${pointIndex}"]`,
    );
    const inputs = coordinateInputs?.querySelectorAll<HTMLInputElement>(
        "input",
    );
    const point = points[pointIndex];

    if (!inputs || inputs.length !== 2 || !point) {
        return;
    }

    inputs[0].value = Math.round(point.textureX).toString();
    inputs[1].value = Math.round(point.textureY).toString();
}

function renderTestPoints(): void {
    testPointsList!.replaceChildren();

    testPoints.forEach((point, index) => {
        const pointEditor = document.createElement("fieldset");
        const title = document.createElement("legend");
        const deleteButton = document.createElement("button");

        pointEditor.className = "point-editor test-point-editor";
        title.textContent = `Test Point ${index + 1}`;
        deleteButton.className = "delete-point";
        deleteButton.type = "button";
        deleteButton.title = `Delete Test Point ${index + 1}`;
        deleteButton.setAttribute(
            "aria-label",
            `Delete Test Point ${index + 1}`,
        );
        deleteButton.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z"/>
            </svg>
        `;
        deleteButton.addEventListener("click", () => {
            testPoints.splice(index, 1);
            renderTestPoints();
            renderPointMarkers();
        });
        pointEditor.append(
            title,
            deleteButton,
            createCoordinateInputPair(
                createPointInput(
                    "World X",
                    point.worldX?.toString() ?? "",
                    (input) => {
                        point.worldX = numberFromInput(input);
                        renderPointMarkers();
                    },
                ),
                createPointInput(
                    "World Y",
                    point.worldY?.toString() ?? "",
                    (input) => {
                        point.worldY = numberFromInput(input);
                        renderPointMarkers();
                    },
                ),
            ),
        );
        testPointsList!.append(pointEditor);
    });
}

addTestPointButton.addEventListener("click", () => {
    testPoints.push({ worldX: null, worldY: null });
    renderTestPoints();
});

renderTestPoints();

function renderPoints(): void {
    pointsList!.replaceChildren();

    points.forEach((point, index) => {
        const pointEditor = document.createElement("fieldset");
        const title = document.createElement("legend");
        const checkLabel = document.createElement("label");
        const checkbox = document.createElement("input");
        const deleteButton = document.createElement("button");

        pointEditor.className = "point-editor";
        title.textContent = `Point ${index + 1}`;
        checkLabel.className = "point-check";
        checkLabel.title = `Select Point ${index + 1}`;
        checkbox.type = "checkbox";
        checkbox.checked = checkedPoints.has(point);
        checkbox.disabled = !checkbox.checked && checkedPoints.size >= 3;
        checkbox.setAttribute(
            "aria-label",
            `Select Point ${index + 1}`,
        );
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                if (checkedPoints.size >= 3) {
                    checkbox.checked = false;
                    return;
                }
                checkedPoints.add(point);
            } else {
                checkedPoints.delete(point);
            }
            renderPoints();
            renderPointMarkers();
        });
        checkLabel.append(checkbox);
        deleteButton.className = "delete-point";
        deleteButton.type = "button";
        deleteButton.title = `Delete Point ${index + 1}`;
        deleteButton.setAttribute(
            "aria-label",
            `Delete Point ${index + 1}`,
        );
        deleteButton.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z"/>
            </svg>
        `;
        deleteButton.addEventListener("click", () => {
            checkedPoints.delete(point);
            points.splice(index, 1);
            renderPoints();
            renderPointMarkers();
        });
        pointEditor.append(
            title,
            checkLabel,
            deleteButton,
            createTextureCoordinateInputs(point, index),
            createCoordinateInputPair(
                createPointInput(
                    "World X",
                    point.worldX?.toString() ?? "",
                    (input) => { point.worldX = numberFromInput(input); },
                    true,
                ),
                createPointInput(
                    "World Y",
                    point.worldY?.toString() ?? "",
                    (input) => { point.worldY = numberFromInput(input); },
                    true,
                ),
            ),
        );
        pointsList!.append(pointEditor);
    });
}

function renderPointMarkers(): void {
    pointsOverlay!.replaceChildren();
    if (!hasTexture) {
        return;
    }

    const viewportBounds = viewport!.getBoundingClientRect();
    const canvasBounds = textureCanvas!.getBoundingClientRect();

    points.forEach((point) => {
        const marker = document.createElement("div");
        marker.className = "point-marker";
        marker.classList.toggle("is-checked", checkedPoints.has(point));
        marker.style.left = `${canvasBounds.left - viewportBounds.left +
            point.textureX / textureCanvas!.width * canvasBounds.width}px`;
        marker.style.top = `${canvasBounds.top - viewportBounds.top +
            point.textureY / textureCanvas!.height * canvasBounds.height}px`;
        pointsOverlay!.append(marker);
    });

    if (!tamrielR) {
        return;
    }

    const textureSize = textureCanvas!.width;
    testPoints.forEach((point) => {
        if (point.worldX === null || point.worldY === null) {
            return;
        }

        const textureX = (
            tamrielR![0][0] * point.worldX +
            tamrielR![0][1] * point.worldY +
            tamrielR![0][2]
        ) * textureSize;
        const textureY = (
            tamrielR![1][0] * point.worldX +
            tamrielR![1][1] * point.worldY +
            tamrielR![1][2]
        ) * textureSize;
        const marker = document.createElement("div");

        marker.className = "point-marker is-test";
        marker.style.left = `${canvasBounds.left - viewportBounds.left +
            textureX / textureCanvas!.width * canvasBounds.width}px`;
        marker.style.top = `${canvasBounds.top - viewportBounds.top +
            textureY / textureCanvas!.height * canvasBounds.height}px`;
        pointsOverlay!.append(marker);
    });
}

function textureCoordinatesAt(
    clientX: number,
    clientY: number,
): { x: number; y: number } {
    const canvasBounds = textureCanvas!.getBoundingClientRect();
    return {
        x: Math.round(Math.max(0, Math.min(
            textureCanvas!.width - 1,
            (clientX - canvasBounds.left) *
            textureCanvas!.width / canvasBounds.width,
        ))),
        y: Math.round(Math.max(0, Math.min(
            textureCanvas!.height - 1,
            (clientY - canvasBounds.top) *
            textureCanvas!.height / canvasBounds.height,
        ))),
    };
}

function pointIndexNear(clientX: number, clientY: number): number | null {
    const canvasBounds = textureCanvas!.getBoundingClientRect();
    let nearestIndex: number | null = null;
    let nearestDistance = POINT_HIT_RADIUS;

    points.forEach((point, index) => {
        const pointX = canvasBounds.left +
            point.textureX / textureCanvas!.width * canvasBounds.width;
        const pointY = canvasBounds.top +
            point.textureY / textureCanvas!.height * canvasBounds.height;
        const distance = Math.hypot(clientX - pointX, clientY - pointY);

        if (distance <= nearestDistance) {
            nearestIndex = index;
            nearestDistance = distance;
        }
    });

    return nearestIndex;
}

function addPointAt(clientX: number, clientY: number): void {
    if (!hasTexture) {
        return;
    }

    const canvasBounds = textureCanvas!.getBoundingClientRect();
    if (
        clientX < canvasBounds.left ||
        clientX > canvasBounds.right ||
        clientY < canvasBounds.top ||
        clientY > canvasBounds.bottom
    ) {
        return;
    }

    const textureCoordinates = textureCoordinatesAt(clientX, clientY);
    const point: PointData = {
        textureX: textureCoordinates.x,
        textureY: textureCoordinates.y,
        worldX: null,
        worldY: null,
    };

    points.push(point);
    if (checkedPoints.size < 3) {
        checkedPoints.add(point);
    }
    renderPoints();
    renderPointMarkers();
}

function updateCanvasTransform(): void {
    textureCanvas!.style.transform =
        `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${zoom})`;
    renderPointMarkers();
}

function resetView(): void {
    zoom = 1;
    panX = 0;
    panY = 0;
    updateCanvasTransform();
}

viewport.addEventListener("wheel", (event) => {
    event.preventDefault();

    const bounds = viewport.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left - bounds.width / 2;
    const pointerY = event.clientY - bounds.top - bounds.height / 2;
    const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, zoom * Math.exp(-event.deltaY * 0.001)),
    );
    const zoomChange = nextZoom / zoom;

    // Adjust the translation so the image pixel below the cursor stays there.
    panX = pointerX - (pointerX - panX) * zoomChange;
    panY = pointerY - (pointerY - panY) * zoomChange;
    zoom = nextZoom;
    updateCanvasTransform();
}, { passive: false });

viewport.addEventListener("pointerdown", (event) => {
    if (event.button === 2) {
        const pointIndex = pointIndexNear(event.clientX, event.clientY);
        if (pointIndex === null) {
            return;
        }

        dragPointerId = event.pointerId;
        draggedPointIndex = pointIndex;
        suppressPointCreation = true;
        viewport.setPointerCapture(event.pointerId);
        return;
    }

    if (event.button !== 0) {
        return;
    }

    dragPointerId = event.pointerId;
    previousPointerX = event.clientX;
    previousPointerY = event.clientY;
    viewport.setPointerCapture(event.pointerId);
});

viewport.addEventListener("pointermove", (event) => {
    if (event.pointerId !== dragPointerId) {
        return;
    }

    if (draggedPointIndex !== null) {
        const textureCoordinates =
            textureCoordinatesAt(event.clientX, event.clientY);
        points[draggedPointIndex].textureX = textureCoordinates.x;
        points[draggedPointIndex].textureY = textureCoordinates.y;
        updateTextureCoordinateInputs(draggedPointIndex);
        renderPointMarkers();
        return;
    }

    panX += event.clientX - previousPointerX;
    panY += event.clientY - previousPointerY;
    previousPointerX = event.clientX;
    previousPointerY = event.clientY;
    updateCanvasTransform();
});

function finishDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) {
        return;
    }

    dragPointerId = null;
    draggedPointIndex = null;

    if (viewport!.hasPointerCapture(event.pointerId)) {
        viewport!.releasePointerCapture(event.pointerId);
    }
}

viewport.addEventListener("pointerup", finishDrag);
viewport.addEventListener("pointercancel", (event) => {
    suppressPointCreation = false;
    finishDrag(event);
});

viewport.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (suppressPointCreation) {
        suppressPointCreation = false;
        return;
    }

    addPointAt(event.clientX, event.clientY);
});

textureInput.addEventListener("change", async () => {
    const file = textureInput.files?.[0];

    if (!file) {
        return;
    }

    if (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) {
        const bitmap = await createImageBitmap(file);
        const context = textureCanvas.getContext("2d");

        if (!context) {
            bitmap.close();
            throw new Error("Could not create the canvas context");
        }

        textureCanvas.width = bitmap.width;
        textureCanvas.height = bitmap.height;

        context.clearRect(0, 0, bitmap.width, bitmap.height);
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        hasTexture = true;
        resetView();

        return;
    }

    if (file.name.toLowerCase().endsWith(".dds")) {
        try {
            const decoded = decodeDds(await file.arrayBuffer());
            const context = textureCanvas.getContext("2d");

            if (!context) {
                throw new Error("Could not create the canvas context");
            }

            textureCanvas.width = decoded.width;
            textureCanvas.height = decoded.height;
            const imageData =
                context.createImageData(decoded.width, decoded.height);
            imageData.data.set(decoded.pixels);
            context.putImageData(imageData, 0, 0);
            hasTexture = true;
            resetView();
        } catch (error) {
            console.error(`Could not load ${file.name}:`, error);
        }
        return;
    }

    console.error(`Unsupported image format: ${file.name}`);
});

window.addEventListener("resize", renderPointMarkers);
