export interface DecodedDds {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
}

const DDS_MAGIC = 0x20534444;
const FOUR_CC_DXT1 = 0x31545844;
const FOUR_CC_DXT3 = 0x33545844;
const FOUR_CC_DXT5 = 0x35545844;
const FOUR_CC_DX10 = 0x30315844;

type BlockFormat = "bc1" | "bc2" | "bc3";

function expand565(color: number): [number, number, number] {
    return [
        Math.round(((color >>> 11) & 0x1f) * 255 / 31),
        Math.round(((color >>> 5) & 0x3f) * 255 / 63),
        Math.round((color & 0x1f) * 255 / 31),
    ];
}

function writeColorBlock(
    source: Uint8Array,
    offset: number,
    target: Uint8ClampedArray,
    width: number,
    height: number,
    blockX: number,
    blockY: number,
    allowTransparency: boolean,
): void {
    const color0 = source[offset] | source[offset + 1] << 8;
    const color1 = source[offset + 2] | source[offset + 3] << 8;
    const first = expand565(color0);
    const second = expand565(color1);
    const colors: [number, number, number, number][] = [
        [first[0], first[1], first[2], 255],
        [second[0], second[1], second[2], 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
    ];

    if (!allowTransparency || color0 > color1) {
        for (let channel = 0; channel < 3; channel++) {
            colors[2][channel] = Math.round(
                (2 * colors[0][channel] + colors[1][channel]) / 3,
            );
            colors[3][channel] = Math.round(
                (colors[0][channel] + 2 * colors[1][channel]) / 3,
            );
        }
    } else {
        for (let channel = 0; channel < 3; channel++) {
            colors[2][channel] = Math.round(
                (colors[0][channel] + colors[1][channel]) / 2,
            );
        }
        colors[3][3] = 0;
    }

    const indices =
        source[offset + 4] |
        source[offset + 5] << 8 |
        source[offset + 6] << 16 |
        source[offset + 7] << 24;

    for (let pixel = 0; pixel < 16; pixel++) {
        const x = blockX * 4 + pixel % 4;
        const y = blockY * 4 + Math.floor(pixel / 4);
        if (x >= width || y >= height) {
            continue;
        }

        const color = colors[(indices >>> (pixel * 2)) & 3];
        const targetOffset = (y * width + x) * 4;
        target[targetOffset] = color[0];
        target[targetOffset + 1] = color[1];
        target[targetOffset + 2] = color[2];
        target[targetOffset + 3] = 255;
    }
}

function decodeBlocks(
    source: Uint8Array,
    offset: number,
    width: number,
    height: number,
    format: BlockFormat,
): Uint8ClampedArray {
    const target = new Uint8ClampedArray(width * height * 4);
    const blockBytes = format === "bc1" ? 8 : 16;
    const blocksWide = Math.ceil(width / 4);
    const blocksHigh = Math.ceil(height / 4);
    const requiredBytes = blocksWide * blocksHigh * blockBytes;

    if (offset + requiredBytes > source.length) {
        throw new Error("DDS pixel data is truncated.");
    }

    for (let blockY = 0; blockY < blocksHigh; blockY++) {
        for (let blockX = 0; blockX < blocksWide; blockX++) {
            const blockOffset =
                offset + (blockY * blocksWide + blockX) * blockBytes;

            if (format === "bc1") {
                writeColorBlock(
                    source,
                    blockOffset,
                    target,
                    width,
                    height,
                    blockX,
                    blockY,
                    true,
                );
                continue;
            }

            if (format === "bc2") {
                writeColorBlock(
                    source,
                    blockOffset + 8,
                    target,
                    width,
                    height,
                    blockX,
                    blockY,
                    false,
                );
                continue;
            }

            writeColorBlock(
                source,
                blockOffset + 8,
                target,
                width,
                height,
                blockX,
                blockY,
                false,
            );
        }
    }

    return target;
}

function channelValue(pixel: number, mask: number, fallback: number): number {
    if (mask === 0) {
        return fallback;
    }

    let shift = 0;
    while (((mask >>> shift) & 1) === 0) {
        shift++;
    }
    const maximum = mask >>> shift;
    return Math.round(((pixel & mask) >>> shift) * 255 / maximum);
}

function decodeRgb(
    view: DataView,
    offset: number,
    width: number,
    height: number,
    bitCount: number,
    pitch: number,
    masks: readonly [number, number, number, number],
): Uint8ClampedArray {
    const bytesPerPixel = bitCount / 8;
    const rowBytes = Math.max(pitch, width * bytesPerPixel);
    const requiredBytes = rowBytes * height;
    if (
        !Number.isInteger(bytesPerPixel) ||
        (bytesPerPixel !== 3 && bytesPerPixel !== 4) ||
        offset + requiredBytes > view.byteLength
    ) {
        throw new Error(`Unsupported or truncated ${bitCount}-bit DDS data.`);
    }

    const target = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sourceOffset = offset + y * rowBytes + x * bytesPerPixel;
            const pixel = bytesPerPixel === 4
                ? view.getUint32(sourceOffset, true)
                : view.getUint8(sourceOffset) |
                    view.getUint8(sourceOffset + 1) << 8 |
                    view.getUint8(sourceOffset + 2) << 16;
            const targetOffset = (y * width + x) * 4;
            target[targetOffset] = channelValue(pixel, masks[0], 0);
            target[targetOffset + 1] = channelValue(pixel, masks[1], 0);
            target[targetOffset + 2] = channelValue(pixel, masks[2], 0);
            target[targetOffset + 3] = 255;
        }
    }
    return target;
}

export function decodeDds(buffer: ArrayBuffer): DecodedDds {
    if (buffer.byteLength < 128) {
        throw new Error("DDS file is too small.");
    }

    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== DDS_MAGIC || view.getUint32(4, true) !== 124) {
        throw new Error("Invalid DDS header.");
    }

    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const pitch = view.getUint32(20, true);
    const pixelFormatSize = view.getUint32(76, true);
    const pixelFormatFlags = view.getUint32(80, true);
    const fourCc = view.getUint32(84, true);
    const bitCount = view.getUint32(88, true);
    const masks = [
        view.getUint32(92, true),
        view.getUint32(96, true),
        view.getUint32(100, true),
        view.getUint32(104, true),
    ] as const;

    if (!width || !height || pixelFormatSize !== 32) {
        throw new Error("Invalid DDS dimensions or pixel format.");
    }

    let dataOffset = 128;
    let blockFormat: BlockFormat | null = null;
    if (fourCc === FOUR_CC_DXT1) {
        blockFormat = "bc1";
    } else if (fourCc === FOUR_CC_DXT3) {
        blockFormat = "bc2";
    } else if (fourCc === FOUR_CC_DXT5) {
        blockFormat = "bc3";
    } else if (fourCc === FOUR_CC_DX10) {
        if (buffer.byteLength < 148) {
            throw new Error("DDS DX10 header is truncated.");
        }
        const dxgiFormat = view.getUint32(128, true);
        dataOffset = 148;
        if (dxgiFormat === 71 || dxgiFormat === 72) {
            blockFormat = "bc1";
        } else if (dxgiFormat === 74 || dxgiFormat === 75) {
            blockFormat = "bc2";
        } else if (dxgiFormat === 77 || dxgiFormat === 78) {
            blockFormat = "bc3";
        } else if (dxgiFormat === 28 || dxgiFormat === 29) {
            return {
                width,
                height,
                pixels: decodeRgb(
                    view,
                    dataOffset,
                    width,
                    height,
                    32,
                    width * 4,
                    [0xff, 0xff00, 0xff0000, 0xff000000],
                ),
            };
        } else {
            throw new Error(`Unsupported DDS DXGI format ${dxgiFormat}.`);
        }
    } else if ((pixelFormatFlags & 0x40) !== 0) {
        return {
            width,
            height,
            pixels: decodeRgb(
                view,
                dataOffset,
                width,
                height,
                bitCount,
                pitch,
                masks,
            ),
        };
    } else {
        throw new Error("Unsupported DDS pixel format.");
    }

    return {
        width,
        height,
        pixels: decodeBlocks(
            new Uint8Array(buffer),
            dataOffset,
            width,
            height,
            blockFormat,
        ),
    };
}
