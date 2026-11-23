// SVG -> PNG with resvg (WebAssembly). The wasm engine and fonts are fetched once per
// worker from jsDelivr (pinned versions) and cached. Never throws: returns null on failure
// so a chart problem can never block an alert.
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";
const FONT_URLS = [
  "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf",
  "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf",
];

export type Loader = (url: string) => Promise<Uint8Array>;
const httpLoader: Loader = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

let ready: Promise<Uint8Array[]> | null = null;

function init(load: Loader): Promise<Uint8Array[]> {
  ready ??= (async () => {
    await initWasm(await load(WASM_URL));
    return await Promise.all(FONT_URLS.map(load));
  })();
  ready.catch(() => { ready = null; }); // allow a retry on the next call
  return ready;
}

export async function svgToPng(svg: string, load: Loader = httpLoader): Promise<Uint8Array | null> {
  try {
    const fonts = await init(load);
    return new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: "DejaVu Sans", loadSystemFonts: false } })
      .render().asPng();
  } catch (e) {
    console.error("chart render failed:", (e as Error).message);
    return null;
  }
}
