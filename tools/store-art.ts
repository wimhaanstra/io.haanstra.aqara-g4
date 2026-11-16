/*
 * Generates the App Store artwork candidates with OpenAI's image API.
 * Reads OPENAI_API_KEY from .env (git- and homey-ignored). Writes to tools/.data/art/.
 *
 *   npx tsx tools/store-art.ts app      # lifestyle image for assets/images (10:7)
 *   npx tsx tools/store-art.ts driver   # product shot on white for the driver images (1:1)
 *   npx tsx tools/store-art.ts icon     # line-icon concepts (redraw the chosen one as SVG)
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, fail } from './common';

const DOORBELL = [
    'an Aqara G4 smart video doorbell:',
    'a tall, flat rectangular slab about 13 cm high with slightly rounded corners, matte black finish;',
    'in the upper third a large circular glossy black glass window containing a small round camera lens with a smaller round motion sensor below it and a tiny light sensor dot above;',
    'in the lower half a large flat circular push button flush with the front, with a tiny bell symbol in its centre;',
    'no other buttons or lights on the front.',
].join(' ');

const PROMPTS: Record<string, { size: string; prompt: string }> = {
    app: {
        size: '1536x1024',
        prompt: [
            `Photorealistic architectural lifestyle photograph of ${DOORBELL}`,
            'It is mounted at chest height on the wall right next to a modern front door of a Scandinavian-style house.',
            'Clean, calm, minimal aesthetic: light warm-grey rendered wall, natural oak front door with a slim black handle, a potted olive tree at the edge, soft late-afternoon daylight with gentle shadows.',
            'The doorbell is clearly visible and in sharp focus, placed slightly right of centre, with generous negative space; shallow depth of field on the background.',
            'Eye-level camera, 35mm lens look, high-end interior-design magazine photography, natural colours.',
            'No people, no text, no logos, no watermarks, no UI overlays.',
        ].join(' '),
    },
    icon: {
        size: '1024x1024',
        prompt: [
            'Minimal monoline line-art icon of a smart video doorbell, for an app icon set.',
            'The doorbell is a tall slim rectangle with softly rounded corners; in its upper part a circle (camera window) with a small round lens inside and a tiny dot below the lens; in its lower part a larger circle (push button) with a small simple bell symbol in the middle.',
            'Seen from the front, turned very slightly to the right so a thin strip of the right side is visible.',
            'Pure black strokes of one uniform, fairly bold weight with round line caps, no fills except tiny dots, no shading, no gradients.',
            'Centred, using most of the canvas height, plain white background.',
            'Flat vector icon style like a modern system icon set. No text, no logos, no chime unit, no extra objects.',
        ].join(' '),
    },
    driver: {
        size: '1024x1024',
        prompt: [
            `Studio product photograph of ${DOORBELL}`,
            'Seen from the front, turned very slightly to the right so its thin side is just visible.',
            'Centred, filling about 70% of the frame height, on a pure white seamless background (#FFFFFF) with a very soft natural contact shadow.',
            'Crisp, evenly lit e-commerce product photography, true-to-life materials.',
            'No other objects, no text, no logos, no watermarks.',
        ].join(' '),
    },
};

function loadKey(): string {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const key = /^OPENAI_API_KEY=(.+)$/m.exec(env)?.[1]?.trim();
    if (!key) throw new Error('OPENAI_API_KEY missing in .env');
    return key;
}

async function main() {
    const kind = process.argv[2] ?? 'app';
    const count = Number(process.argv[3] ?? 2);
    const spec = PROMPTS[kind];
    if (!spec) throw new Error(`Unknown kind "${kind}" (use app or driver)`);

    const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${loadKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-image-2',
            prompt: spec.prompt,
            size: spec.size,
            quality: 'high',
            n: count,
            output_format: 'png',
        }),
    });
    const body = (await response.json()) as any;
    if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);

    const outDir = path.join(DATA_DIR, 'art');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    body.data.forEach((image: { b64_json: string }, index: number) => {
        const file = path.join(outDir, `${kind}-${stamp}-${index + 1}.png`);
        fs.writeFileSync(file, Buffer.from(image.b64_json, 'base64'));
        console.log(file);
    });
}

main().catch(fail);
