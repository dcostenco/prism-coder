const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const OMLX_MAX_IMAGES = 4;
export const OMLX_MAX_IMAGE_BYTES = 128 * 1024;
export const OMLX_MAX_IMAGE_BYTES_TOTAL = 192 * 1024;
export const OMLX_MAX_IMAGE_SIDE = 2048;
export const OMLX_MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
export const OMLX_MAX_IMAGE_PIXELS_TOTAL = 8 * 1024 * 1024;
export interface OmlxImageLimits {
    images: number; image_bytes: number; total_image_bytes: number;
    image_side: number; image_pixels: number; total_image_pixels: number;
}
export const OMLX_IMAGE_LIMITS: Readonly<OmlxImageLimits> = Object.freeze({ images: OMLX_MAX_IMAGES,
    image_bytes: OMLX_MAX_IMAGE_BYTES, total_image_bytes: OMLX_MAX_IMAGE_BYTES_TOTAL,
    image_side: OMLX_MAX_IMAGE_SIDE, image_pixels: OMLX_MAX_IMAGE_PIXELS, total_image_pixels: OMLX_MAX_IMAGE_PIXELS_TOTAL });
const MAX_B64 = Math.ceil(OMLX_MAX_IMAGE_BYTES / 3) * 4;
const MAX_B64_TOTAL = Math.ceil(OMLX_MAX_IMAGE_BYTES_TOTAL / 3) * 4;

export type OmlxImageMessage = { role: string; content: string; images?: readonly string[] };

function decodePng(value: string): Uint8Array {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_B64 || value.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("omlx_image_invalid");
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || bytes.length > OMLX_MAX_IMAGE_BYTES
        || bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((b, i) => bytes[i] === b))
        throw new Error("omlx_image_invalid");
    return bytes;
}

/** Validate transport-level image representation; full PNG decode remains server-owned. */
export function validateOmlxMessages(value: unknown): OmlxImageMessage[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error("omlx_messages_invalid");
    const messages: OmlxImageMessage[] = [];
    let totalEncoded = 0;
    let totalImages = 0;
    for (let messageIndex = 0; messageIndex < value.length; messageIndex++) {
        if (!Object.hasOwn(value, messageIndex)) throw new Error("omlx_messages_invalid");
        const entry = value[messageIndex];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("omlx_messages_invalid");
        const record = entry as Record<string, unknown>;
        if (!Object.hasOwn(record, "role") || !Object.hasOwn(record, "content")
            || typeof record.role !== "string" || typeof record.content !== "string") throw new Error("omlx_messages_invalid");
        if (!("images" in record)) { messages.push({ role: record.role, content: record.content }); continue; }
        if (!Object.hasOwn(record, "images")) throw new Error("omlx_image_invalid");
        if (record.role !== "user" || !Array.isArray(record.images) || record.images.length === 0
            || record.images.length > OMLX_MAX_IMAGES) throw new Error("omlx_image_invalid");
        totalImages += record.images.length;
        if (totalImages > OMLX_MAX_IMAGES) throw new Error("omlx_image_invalid");
        const images: string[] = [];
        for (let imageIndex = 0; imageIndex < record.images.length; imageIndex++) {
            if (!Object.hasOwn(record.images, imageIndex)) throw new Error("omlx_image_invalid");
            const image = record.images[imageIndex];
            if (typeof image !== "string") throw new Error("omlx_image_invalid");
            if (image.length > MAX_B64 || totalEncoded + image.length > MAX_B64_TOTAL) throw new Error("omlx_image_invalid");
            totalEncoded += image.length;
            decodePng(image);
            images.push(image);
        }
        messages.push({ role: record.role, content: record.content, images });
    }
    return messages;
}

export function responsesInput(messages: readonly OmlxImageMessage[]): unknown[] {
    return validateOmlxMessages(messages).map(message => message.images === undefined
        ? { role: message.role, content: message.content }
        : { role: message.role, content: [
            { type: "input_text", text: message.content },
            ...message.images.map(image => ({ type: "input_image", image_url: `data:image/png;base64,${image}` })),
        ] });
}

/** Preflight final bytes and PNG dimensions; full decode/CRC remain server-owned. */
export function validateOmlxImageInput(images: readonly string[], limits: Readonly<OmlxImageLimits>): void {
    validateOmlxMessages([{ role: "user", content: "", images }]);
    const bounded = { ...OMLX_IMAGE_LIMITS };
    for (const key of Object.keys(bounded) as (keyof OmlxImageLimits)[]) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error("omlx_image_invalid");
        bounded[key] = Math.min(bounded[key], limits[key]);
    }
    if (images.length > bounded.images) throw new Error("omlx_image_too_large");
    let bytes = 0, pixels = 0;
    for (const image of images) {
        const data = Buffer.from(image, "base64");
        if (data.length < 33 || data.readUInt32BE(8) !== 13 || data.toString("ascii",12,16) !== "IHDR") throw new Error("omlx_image_invalid");
        const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
        if (!width || !height) throw new Error("omlx_image_invalid");
        if (width > bounded.image_side || height > bounded.image_side) throw new Error("omlx_image_too_large");
        bytes += data.length; pixels += width * height;
        if (data.length > bounded.image_bytes || bytes > bounded.total_image_bytes
            || width * height > bounded.image_pixels || pixels > bounded.total_image_pixels)
            throw new Error("omlx_image_too_large");
    }
}
