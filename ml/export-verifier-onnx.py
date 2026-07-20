"""Export the crop-verifier .pt -> .onnx. Usage:
   export-verifier-onnx.py [in.pt] [out.onnx]  (defaults ml/crop-verifier.{pt,onnx})
Architecture must match train-crop-verifier.py."""
import sys
from pathlib import Path
import torch
import torch.nn as nn
from torchvision.models import mobilenet_v3_small

ROOT = Path(__file__).resolve().parent
PT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "crop-verifier.pt"
ONNX = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "crop-verifier.onnx"
CROP = 96


class CropVerifier(nn.Module):
    def __init__(self):
        super().__init__()
        b = mobilenet_v3_small(weights=None)
        self.backbone = b.features
        self.head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(576, 1))

    def forward(self, x):
        return self.head(self.backbone(x)).view(-1)


def main():
    m = CropVerifier()
    m.load_state_dict(torch.load(PT, map_location="cpu", weights_only=True))
    m.eval()
    dummy = torch.randn(1, 3, CROP, CROP)
    torch.onnx.export(
        m, dummy, str(ONNX), input_names=["crop"], output_names=["logit"],
        dynamic_axes={"crop": {0: "batch"}, "logit": {0: "batch"}},
        opset_version=17, dynamo=False,
    )
    print(f"Exported {ONNX} ({ONNX.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
