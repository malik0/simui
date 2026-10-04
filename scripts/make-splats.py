"""Turns every story photo in database-news/images into a 3D Gaussian splat with Apple's SHARP.

    npm run splats

Runs inside the SHARP virtual environment (.sharp/venv, see .sharp/ml-sharp). The model loads once and photos that
already have a splat are skipped, so it is safe to re-run after `npm run news`. Output: database-news/splats/<name>.ply

Licence note: the SHARP model weights are for research use only (see .sharp/ml-sharp/LICENSE_MODEL).
"""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

import torch

from sharp.cli.predict import DEFAULT_MODEL_URL, predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils import io
from sharp.utils.gaussians import save_ply

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "database-news" / "images"
OUT = ROOT / "database-news" / "splats"

logging.basicConfig(level=logging.WARNING)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    photos = sorted(p for p in IMAGES.iterdir() if p.suffix.lower() == ".jpg")
    todo = [p for p in photos if not (OUT / f"{p.stem}.ply").exists()]
    print(f"{len(photos)} photos, {len(todo)} still need a splat", flush=True)
    if not todo:
        return 0

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"loading the model on {device}...", flush=True)
    state_dict = torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=False)  # cached under TORCH_HOME
    predictor = create_predictor(PredictorParams())
    predictor.load_state_dict(state_dict)
    predictor.eval().to(device)

    started = time.time()
    for i, path in enumerate(todo, 1):
        t0 = time.time()
        try:
            image, _, f_px = io.load_rgb(path)
            height, width = image.shape[:2]
            gaussians = predict_image(predictor, image, f_px, device)
            save_ply(gaussians, f_px, (height, width), OUT / f"{path.stem}.ply")
        except Exception as e:  # keep going: one odd photo should not stop the batch
            print(f"[{i}/{len(todo)}] {path.name}: FAILED ({e})", flush=True)
            continue
        print(f"[{i}/{len(todo)}] {path.name} ({time.time() - t0:.1f}s)", flush=True)
    print(f"done in {time.time() - started:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
