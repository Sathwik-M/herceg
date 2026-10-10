# PDF font fixtures

These test-only fonts are unhinted subsets of Noto Sans Regular, Noto Sans
Bold, and Noto Sans Symbols 2 Regular, licensed under the SIL Open Font
License 1.1 (see [OFL.txt](OFL.txt)). They are not shipped font assets.

Origin: [notofonts/noto-fonts](https://github.com/notofonts/noto-fonts/tree/ffebf8c1ee449e544955a7e813c54f9b73848eac),
commit `ffebf8c1ee449e544955a7e813c54f9b73848eac`, under `hinted/ttf/NotoSans/` and
`hinted/ttf/NotoSansSymbols2/`. Downloaded 2026-10-10.

Original SHA-256 hashes:

- `NotoSans-Regular.ttf`: `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`
- `NotoSans-Bold.ttf`: `c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a`
- `NotoSansSymbols2-Regular.ttf`: `630846d528dbe4c4981370a4d0a9475a1fd1491a129bb411f8e157cdb5de13c6`

Created with fontTools 4.66.1 (`pyftsubset`, development tooling only),
`--no-hinting --name-IDs=1,2,4,6 --name-languages=0x409`.
Sans faces additionally use `--drop-tables+=GSUB,GPOS,GDEF` and retain
`U+0020-007E,U+00A0,U+00B7,U+00E4,U+00E9,U+00E7,U+00ED,U+02BC,U+0301,U+0308,U+0394,U+03A9,U+03B1,U+03BC,U+041C,U+0438,U+0440,U+2026,U+2212`.
Symbols retains `U+1D300,U+2605`. Composite dependencies and `.notdef`
are included by fontTools. The Latin faces exercise cmap format 4; the symbol face exercises format 12
and supplementary scalars.

`test/render/pdf-font-validation.test.ts` builds deterministic OS/2 fixtures
from the sans face: legacy version 0 at 68 and 78 bytes, version 1 at 86 bytes,
versions 2–4 at 96 bytes, and version 5 at 100 bytes, plus truncated variants.
It sets legacy bitmap/no-subsetting bits to test that versions 0–1 ignore them.
The same tests rebuild composite glyphs with XY placement, point attachments,
nested outlines, phantom-point boundaries, and conflicting transform flags.
