// One-off correction job: re-snaps every mascot pose (idle included) to
// the mouth_open image's exact color palette, in place, with no new
// Gemini calls. See recolorAllMascotPosesToMouthOpenPalette() in
// generate-assets.ts for why mouth_open (not idle) is the canonical color
// reference.

import { recolorAllMascotPosesToMouthOpenPalette } from "./generate-assets.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  recolorAllMascotPosesToMouthOpenPalette()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
