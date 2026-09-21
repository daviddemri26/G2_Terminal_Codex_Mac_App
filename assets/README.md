# Application icon

`app-icon.png` is the 1024 × 1024 source artwork for G2 Bridge. It has an alpha
channel and a dark macOS tile with a compact emerald glasses/bridge mark.
The application consumes `../macos/Resources/AppIcon.icns`.

The original artwork was generated on 2026-09-21 with the built-in ImageGen
tool, visually inspected, and resized/packaged with the macOS `sips` and
`iconutil` utilities. No Even or OpenAI logo was used.

To rebuild the `.icns` file on macOS from this committed PNG:

```sh
mkdir -p .build/AppIcon.iconset macos/Resources
for icon_size in 16 32 128 256 512; do
  sips -z "$icon_size" "$icon_size" assets/app-icon.png \
    --out ".build/AppIcon.iconset/icon_${icon_size}x${icon_size}.png" >/dev/null
  retina_size=$((icon_size * 2))
  sips -z "$retina_size" "$retina_size" assets/app-icon.png \
    --out ".build/AppIcon.iconset/icon_${icon_size}x${icon_size}@2x.png" >/dev/null
done
iconutil -c icns .build/AppIcon.iconset -o macos/Resources/AppIcon.icns
```

The committed `.icns` means a normal application build does not need to
regenerate the icon. `iconutil` can fail with `Invalid Iconset` inside a
restricted process sandbox even when all PNG sizes are correct; running this
local conversion with normal macOS filesystem permissions resolves that case.

## Generation prompt

> Use case: logo-brand
>
> Asset type: production macOS application Dock icon for G2 Bridge, square 1024 by 1024 PNG with genuine transparency outside the rounded-square tile.
>
> Primary request: Create a beautiful minimal Mac app icon for a local bridge connecting smart glasses to a computer. This is the icon artwork itself, not a photograph or screen mockup.
>
> Scene/backdrop: genuinely transparent background. Center one near-black rounded-square macOS icon tile, filling about 86 percent of the canvas, with generous perfectly even transparent margins, soft rounded corners, subtle bevel and almost imperceptible shadow.
>
> Subject: one strong simple geometric emerald mark that suggests two glass lenses linked by a short bridge: two symmetrical softly squared luminous emerald green outlines joined by a short clean horizontal bar at their inner upper edge, like elegant modern smart glasses, no temples, no realistic eyewear. The whole symbol must be bold, compact and balanced, readable at small Dock size.
>
> Style/medium: premium restrained macOS app icon rendering, graphite black tile with subtle depth, emerald luminous glass or anodized finish on a clean thick geometric symbol. Crisp edges, uncluttered, front view, orthographic.
>
> Composition/framing: single centered icon, symmetrical, no perspective, symbol occupies about 64 percent of tile width.
>
> Color palette: near black charcoal tile, rich emerald green mark, very subtle mint highlights, no other colors.
>
> Constraints: No text, no letters, no numbers, no watermark. No Even logo, no OpenAI logo, no brands. No extra decorative objects, no chart, no signal waves, no extra app icons. True alpha around the tile; do not render a checkerboard or white background. Favor a distinctive bold silhouette over tiny details.
