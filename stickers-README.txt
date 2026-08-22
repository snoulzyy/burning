Put your sticker images in this folder.

Then open public/index.html and find the STICKERS list near the top of the
script. Each entry points at a filename in here:

  { file: "char.png", where: "left", top: "16%", w: 104 },

  file  - the filename in this folder
  where - "left" / "right"  float in the margin beside the board.
                            Only show on wide screens, never cover a channel.
          "header"/"footer" sit inline, visible at any width.
  w     - width in pixels
  top   - how far down the screen (left/right only)

Add, remove or duplicate lines freely. A line pointing at a file that isn't
here is skipped silently, so nothing breaks.

PNG with a transparent background looks best on the dark theme.
