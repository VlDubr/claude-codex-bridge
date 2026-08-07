---
description: Generate an image (GPT Image 2) and verify that it meets the requirements
argument-hint: "[--ar 16:9] [--res 2K] [--ref file|url] [--out directory] [--no-check] <description>"
allowed-tools: mcp__plugin_codex-bridge_image__image_generate, mcp__plugin_codex-bridge_image__image_check_params, Read
---

The user is requesting an image: `$ARGUMENTS`

## 1. Parse the arguments

- `--ar` → `aspect_ratio` (1:1, 9:16, 16:9, 4:3, 3:4, auto)
- `--res` → `image_resolution` (1K, 2K, 4K)
- `--ref` → add to `images` (repeatable; path to a local file, up to 16 files)
- `--out` → `out_dir`
- `--name` → base filename
- everything else → `prompt`

Keep the constraints in mind: `auto` supports only 1K, while `1:1` does not support 4K. If the user requests an incompatible combination, do not send the request blindly—identify the conflict and suggest the closest supported option (for example, the maximum resolution for a square image is 2K).

If no output directory is specified and the project already has an obvious location for assets (`assets/`, `public/images/`, `static/img/`), use it instead of the default and mention that choice.

## 2. Expand the prompt

Expand the user's brief request into a meaningful description: subject, composition and camera angle, style, lighting, palette, background, and—separately—what must not appear in the image. The model handles specifics much better than generalities. Show the user the final prompt on one line so they can see exactly what was sent for generation.

## 3. Generate the image

Call **image_generate**. Before an expensive 4K generation, it is worth checking the parameters with **image_check_params** first.

The built-in Codex tool (gpt-image-2) generates the image using ChatGPT authentication—no API key is required, and usage counts against the subscription limits. A call takes 4–6 minutes, and longer at 4K: warn the user and do not treat a long wait as a failure.

References must be local files: the built-in tool does not accept URLs. If the user provided a link, first download the image into the project, then pass its path.

## 4. Verify the result—this step is mandatory

Open the saved file with the **Read** tool: you can see images and evaluate them. Check each item:

- Is the main subject present, and does it match the request?
- Are the explicit requirements satisfied—the number of objects, colors, text, and camera angle?
- Is everything that was supposed to be excluded absent?
- Are there any obvious artifacts: extra limbs, distorted text, or cropped composition?
- Is the aspect ratio suitable for the stated use?

Give an honest verdict. Do not present “roughly similar” as success.

## 5. Iterate when the result does not match

If the result does not match the requirements, do not present it to the user as finished. Refine the prompt to target the exact mismatch and generate it again—up to two retries without asking again. If it still does not match after that, show the best version, explain exactly what did not work, and suggest changing the wording or adding a reference.

If `--no-check` is set, skip steps 4 and 5 and simply return the file path.

## 6. Report the outcome

Provide the file path relative to the project root, the parameters used, the verification result, and the number of attempts required.
