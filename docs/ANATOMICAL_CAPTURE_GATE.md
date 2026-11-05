# AnemoScan anatomical capture gate

## Capture classes

The anatomical gate must distinguish these five classes:

1. `closed_eye`: eyelids closed or nearly closed; no usable palpebral conjunctiva.
2. `open_eye_no_conjunctiva`: eye open, but the lower palpebral conjunctiva is not exposed.
3. `partial_conjunctiva`: some inner lower eyelid is visible, but the exposure is insufficient for a reliable capture.
4. `conjunctiva_visible`: lower palpebral conjunctiva is clearly exposed and sufficiently visible for the study's capture protocol.
5. `unusable_image`: wrong anatomy, severe blur, obstruction, extreme crop, or image that cannot be assessed.

## Decision policy

- Only `conjunctiva_visible` may pass the anatomical gate.
- Use a confidence threshold of at least 0.90 and a top-class versus second-class margin of at least 0.20 as initial engineering thresholds. These are provisional and must be calibrated on a held-out, independently reviewed validation set.
- Low-confidence or ambiguous outputs must return `uncertain`, never pass.
- A quality score, sclera pixel ratio, skin-tone ratio, eye openness estimate, or generic face landmark is not proof that lower palpebral conjunctiva is exposed.
- Automatic capture must require both the existing image-quality gate and the anatomical gate to remain valid across consecutive frames for 1.5–2 seconds. Capture once, then lock until the user repositions or starts a new scan.

## Current data limitations

The supplied 200-image archive is mainly close-up eye images with the lower lid pulled down. It is a source of candidate positive examples, not a balanced five-class dataset. Existing filenames do not provide reviewed class labels or consent/ethics metadata.

Use external datasets only as references or where their terms permit the exact intended use:
- RT-BENE can guide open-eye versus blink/closed-eye examples, but it does not label lower palpebral conjunctiva exposure.
- Eyes Defy Anemia can guide examples of conjunctiva-visible images, subject to its dataset terms. It does not provide the required negative anatomical classes.
- Do not use unlabelled Google Images photos as training labels.

## Implementation status

The frontend now contains a conservative prediction-validation contract in `web/src/lib/anatomical-gate.ts`. It is not a trained model and does not classify pixels. A model artifact and reviewed labels are still required before wiring it into capture acceptance or enabling automatic capture. This is intentional: the current heuristic quality checks must not be presented as anatomical recognition.
