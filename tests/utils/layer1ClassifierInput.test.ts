/**
 * The classifier-input policy: the classifier's copy of a request leaves out
 * a sentence when every word is listed, each required group is present, and
 * each qualified word follows one of its words. A synthetic policy stands in
 * for the real one, which is not public.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import {
    callLayer1,
    classifierCopy,
    classifyDeterministicLayer1,
    layer1ClassifierContent,
    buildOversizeExcerpt,
    MAX_CLASSIFIER_PROMPT_LENGTH,
} from "../../src/utils/layer1.js";
import { parseClassifierInputPolicy } from "../../src/utils/inferencePolicy.js";
import { _resetBakedSystemCacheForTest } from "../../src/utils/ollamaSystemPrompt.js";

beforeEach(() => { _resetBakedSystemCacheForTest(); });

const BYTES = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/classifier-input-policy.synthetic.json", import.meta.url), "utf8")));
const P = parseClassifierInputPolicy(BYTES, createHash("sha256").update(BYTES).digest("hex"))!;
const LISTED = "Lorem ipsum dolor sit amet.";

describe("classifierCopy", () => {
    it("the synthetic policy parses", () => {
        expect(P).not.toBeNull();
        expect(P.dropWords.has("lorem")).toBe(true);
    });

    it("leaves out a sentence made only of listed words, wherever it sits", () => {
        const req = "`total(rows)` sums the counts.";
        expect(classifierCopy(`Write a function. ${LISTED}\n\n${req}`, P)).toBe(`Write a function.\n\n${req}`);
        expect(classifierCopy(`${LISTED} Write a function.\n${req}`, P)).toBe(`Write a function.\n${req}`);
        expect(classifierCopy(`Write a function.\n\n${req}\n\nSed do, amet!`, P)).toBe(`Write a function.\n\n${req}`);
        expect(classifierCopy(`Write a function. ${LISTED} Sed amet elit.\n\n${req}`, P)).toBe(`Write a function.\n\n${req}`);
    });

    it("returns text with nothing to leave out unchanged, byte for byte", () => {
        for (const text of [
            "Write a function. `total(rows)` sums the counts.",
            "write the login token verification handler",
            "  leading and trailing space  \n\n",
            "Lorem ipsum with one other word.",
            "Which of these is darker: $` or $'?",
            "",
        ]) expect(classifierCopy(text, P)).toBe(text);
    });

    it("keeps a sentence whole when any word is not listed", () => {
        for (const sentence of ["Lorem ipsum session dolor.", "Sit amet (restraint).", "Dolor sit, dose.", "Lorem ipsum deploy."]) {
            const text = `Write a function. ${sentence}\n\n\`f(x)\` returns x.`;
            expect(classifierCopy(text, P)).toBe(text);
        }
    });

    it("counts pattern tokens as listed, but never toward a group; a sentence of pattern tokens alone is kept", () => {
        expect(classifierCopy("Write a function. Lorem ++abc dolor.\n\nThe spec.", P)).toBe("Write a function.\n\nThe spec.");
        expect(classifierCopy("Write a function. Lorem ipsum ++dolor.\n\nThe spec.", P)).toBe("Write a function. Lorem ipsum ++dolor.\n\nThe spec.");
        expect(classifierCopy("Write a function.\n++abc\nThe spec.\n++", P)).toBe("Write a function.\n++abc\nThe spec.\n++");
    });

    it("keeps a sentence of listed words that lacks a word from any required group", () => {
        for (const sentence of ["Ipsum sit.", "Lorem ipsum.", "Dolor sit amet.", "Consectetur adipiscing elit."]) {
            const text = `Write a function. ${sentence}\n\nThe spec.`;
            expect(classifierCopy(text, P), sentence).toBe(text);
        }
    });

    it("counts a qualified word only right after one of its words or a token matching the qualifier pattern", () => {
        expect(classifierCopy("The spec. Sed amet elit.", P)).toBe("The spec.");
        expect(classifierCopy("The spec. Sed ++x elit dolor.", P)).toBe("The spec.");
        for (const sentence of ["Elit sed amet.", "Sed elit amet.", "Sed dolor, elit.", "Sed ++ elit dolor."]) {
            const text = `The spec. ${sentence}`;
            expect(classifierCopy(text, P), sentence).toBe(text);
        }
    });

    it("never leaves out a sentence with a question mark, in any script prism serves", () => {
        const marks = [0xff1f, 0xfe56, 0x061f, 0x037e, 0x00bf, 0x203d, 0x2047, 0x2048, 0x2049, 0x2e2e, 0x055e, 0x1367].map(c => String.fromCharCode(c));
        for (const text of ["The spec. Lorem ipsum dolor?", "Lorem dolor? The spec.", "The spec.\nSed amet elit?  ",
            "The spec. Lorem dolor?!", "The spec. Lorem dolor?\"", "The spec. Lorem (dolor?)", "The spec.\nLorem ? dolor",
            ...marks.map(m => `The spec. Lorem dolor${m}`)]) {
            expect(classifierCopy(text, P), text).toBe(text);
        }
    });

    it("keeps every other character, leading and trailing whitespace included", () => {
        expect(classifierCopy("  Write a function.\nLorem ipsum dolor.\n", P)).toBe("  Write a function.\n");
        expect(classifierCopy("\nLorem ipsum dolor.\nThe spec.  ", P)).toBe("\nThe spec.  ");
    });

    it("leaves nothing out unless a sentence that stays has one of the words the policy needs", () => {
        for (const text of [`Here are the notes. ${LISTED}`, `The vault. ${LISTED}\nSed amet.`, `${LISTED} Lorem dolor.`]) {
            expect(classifierCopy(text, P), text).toBe(text);
        }
        expect(classifierCopy(`Here is the spec. ${LISTED}`, P)).toBe("Here is the spec.");
        expect(classifierCopy(`${LISTED} Write it.`, P)).toBe("Write it.");
    });

    it("never returns an empty request", () => {
        expect(classifierCopy(LISTED, P)).toBe(LISTED);
    });

    it("ends a sentence at a non-breaking space, a lone carriage return and CRLF", () => {
        const spec = "`sumDigits(n)` returns the sum of the digits.";
        expect(classifierCopy(`Write a function. ${LISTED} ${spec}`, P)).toBe(`Write a function. ${spec}`);
        expect(classifierCopy(`Write a function.\r${LISTED}\r${spec}`, P)).toBe(`Write a function.\r${spec}`);
        expect(classifierCopy(`Write a function.\r\n\r\n${LISTED}\r\n\r\n${spec}`, P)).toBe(`Write a function.\r\n\r\n${spec}`);
    });

    it("never loses a word that is not listed, over many generated requests", () => {
        const OTHER = ["session", "token", "login", "password", "deploy", "ship", "dose", "mg", "restraint",
            "seclusion", "suicide", "diagnosis", "patient", "bypass", "crisis", "(session)", "‹token›", "dose.", "write"];
        const LIST = ["lorem", "ipsum", "dolor", "sit,", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "++x"];
        const SEPS = [" ", ". ", ".\n", "\n\n", ". ", "\r", "\r\n", "! ", "? ", ", ", "; "];
        let seed = 7;
        // The high bits: this generator's low bits repeat with a short period.
        const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
        const count = (s: string, w: string) => s.split(w).length - 1;
        let changed = 0;
        for (let i = 0; i < 2000; i++) {
            let text = rnd(2) ? "Write it. " : "";
            const words = 3 + rnd(25);
            for (let k = 0; k < words; k++) {
                const w = rnd(4) === 0 ? OTHER[rnd(OTHER.length)] : LIST[rnd(LIST.length)];
                text += w + SEPS[rnd(SEPS.length)];
            }
            const out = classifierCopy(text, P);
            for (const w of OTHER) expect(count(out, w), `${JSON.stringify(text)} lost ${w}`).toBe(count(text, w));
            if (out !== text) { changed++; expect(out.length).toBeLessThan(text.length); }
        }
        expect(changed).toBeGreaterThan(100);
    });
});

function spyFetch(reply: string) {
    const sent: string[] = [];
    const fetchImpl = (async (u: unknown, init?: { body?: unknown }) => {
        if (String(u).endsWith("/api/show")) return new Response(JSON.stringify({ system: "baked" }), { status: 200 });
        const messages = JSON.parse(String(init?.body)).messages as Array<{ role: string; content: string }>;
        sent.push(messages[messages.length - 1].content);
        return new Response(JSON.stringify({ message: { content: reply } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
}

describe("callLayer1 with a classifier-input policy", () => {
    const text = `Write a function. ${LISTED}\n\n\`range(a, b)\` returns the numbers from a up to b.`;

    it("sends the classifier the copy", async () => {
        const { sent, fetchImpl } = spyFetch("OBVIOUS_NOT_RESERVED");
        expect(await callLayer1(text, "http://x", "prism-coder:4b", fetchImpl, undefined, { classifierInput: P })).toBe("OBVIOUS_NOT_RESERVED");
        expect(sent).toEqual([layer1ClassifierContent(classifierCopy(text, P))]);
        expect(sent[0]).not.toContain("Lorem");
    });

    it("without a policy sends the request as written", async () => {
        for (const opts of [undefined, {}, { classifierInput: null }]) {
            const { sent, fetchImpl } = spyFetch("OBVIOUS_NOT_RESERVED");
            await callLayer1(text, "http://x", "prism-coder:4b", fetchImpl, undefined, opts);
            expect(sent).toEqual([layer1ClassifierContent(text)]);
        }
    });

    it("the deterministic floor reads the full request: reserved text is refused before any model call", async () => {
        for (const t of [
            `Write the login token verification handler. ${LISTED}`,
            `${LISTED} Write the hold procedure for when he starts hitting staff.`,
        ]) {
            expect(classifyDeterministicLayer1(t), t).toBe("OBVIOUS_RESERVED");
            const { sent, fetchImpl } = spyFetch("OBVIOUS_NOT_RESERVED");
            expect(await callLayer1(t, "http://x", "prism-coder:4b", fetchImpl, undefined, { classifierInput: P }), t).toBe("OBVIOUS_RESERVED");
            expect(sent, t).toEqual([]);
        }
    });

    it("classifies a request with an image as written", async () => {
        const { sent, fetchImpl } = spyFetch("OBVIOUS_NOT_RESERVED");
        await callLayer1(text, "http://x", "prism-coder:4b", fetchImpl, ["aW1hZ2U="], { classifierInput: P });
        expect(sent).toContain(layer1ClassifierContent(text));
        expect(sent.some((c) => c === layer1ClassifierContent(classifierCopy(text, P)))).toBe(false);
    });

    it("keeps the model's reserved verdict on the copy", async () => {
        const { sent, fetchImpl } = spyFetch("OBVIOUS_RESERVED");
        expect(await callLayer1(text, "http://x", "prism-coder:4b", fetchImpl, undefined, { classifierInput: P })).toBe("OBVIOUS_RESERVED");
        expect(sent).toHaveLength(1);
    });
});

describe("callLayer1 on an oversize request with a classifier-input policy", () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `Row ${i} holds a plain inventory count.`).join("\n");

    it("classifies the copy of the excerpt, markers kept", async () => {
        const text = `Write a function. ${LISTED}\n\`total(rows)\` sums the counts below.\n${filler(300)}`;
        expect(text.length).toBeGreaterThan(MAX_CLASSIFIER_PROMPT_LENGTH);
        const { sent, fetchImpl } = spyFetch("OBVIOUS_NOT_RESERVED");
        expect(await callLayer1(text, "http://x", "prism-coder:4b", fetchImpl, undefined, { classifierInput: P })).toBe("UNCERTAIN_LENGTH");
        expect(sent).toEqual([layer1ClassifierContent(classifierCopy(buildOversizeExcerpt(text), P))]);
        expect(sent[0]).not.toContain("Lorem");
        expect(sent[0].split("[…]").length - 1).toBe(2);
    });

    it("still refuses reserved vocabulary in the part the excerpt skips, before any model call", async () => {
        const text = `Write a function. ${LISTED}\n${filler(60)}\nThe staff restraint hold lasts ten minutes.\n${filler(240)}\n${LISTED}`;
        expect(text.length).toBeGreaterThan(MAX_CLASSIFIER_PROMPT_LENGTH);
        expect(buildOversizeExcerpt(text)).not.toContain("restraint");
        const { sent, fetchImpl } = spyFetch("OBVIOUS_NOT_RESERVED");
        expect(await callLayer1(text, "http://x", "prism-coder:4b", fetchImpl, undefined, { classifierInput: P })).toBe("OBVIOUS_RESERVED");
        expect(sent).toEqual([]);
    });
});
